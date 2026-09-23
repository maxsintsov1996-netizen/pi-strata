/**
 * pi-strata — layered KV-cache-friendly context management for pi-coding-agent
 * with local LLMs (llama.cpp / Ollama). See SPEC.md.
 *
 * Context layout (prompt prefix must be byte-stable across steps):
 *
 *   [Layer 0] system prompt (+ static pi-strata instructions)
 *     [Layer 1] RESEARCH marker block (in the conversation)
 *       [Layer 2] PLAN marker block (the plan / TODO list)
 *         [Layer 3] STEP-N marker blocks (append-only step reports)
 *           [current] ephemeral task + tool outputs (discarded into reports)
 *
 * Layer data lives in the conversation, not in files: the model writes each
 * phase between STRATA:: markers, and layers 1–3 are injected as the
 * deterministic compaction summary (the extracted blocks re-emitted in fixed
 * order), so after every phase compaction the prefix [system + layers] is
 * unchanged except for the replaced/appended blocks — the llama.cpp KV cache
 * survives.
 *
 * The session strata directory (next to the session file,
 * <session>.pi_strata/) holds raw context snapshots (tmp/) only.
 */

import {
  getAgentDir,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import { resolveStrataSettings } from "./config.ts";
import {
  handleSessionBeforeCompact,
  type StrataDetails,
  type StrataRuntime,
} from "./compaction.ts";
import {
  SEP,
  cleanupOrphanedStrataDirs,
  extractLayers,
  fitLine,
  firstUnreportedPlanStep,
  itemText,
  modeSegments,
  parsePlan,
  planDashboardSegments,
  reportPlanCounts,
  strataPaths,
  stripStrataMarkersForDisplay,
  type StrataLayers,
  type WidgetSegment,
} from "./strata.ts";

/**
 * customType of the standing-instructions message injected by /strata-on in
 * a session that already carries context (KV-cache guard: the system prompt
 * must not change mid-session, so the layer-0 instructions ride on a message
 * appended at the end of the context until the next compaction).
 */
const INSTRUCTIONS_CUSTOM_TYPE = "strata-instructions";

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, never>;
  isError?: boolean;
}

const toolText = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  details: {},
  isError,
});

/** Session-scoped strata directory: next to the session file. */
function resolveStrataDir(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager;
  const file = sm.getSessionFile();
  if (file) return join(dirname(file), `${basename(file, ".jsonl")}.pi_strata`);
  return join(getAgentDir(), "strata", sm.getSessionId());
}

/** Static per-session instructions appended to the system prompt (layer 0). */
export function buildStrataInstructions(strataDir: string): string {
  const p = strataPaths(strataDir);
  return `## PI-STRATA — layered context (KV-cache optimization)

You work with a layered context so that llama.cpp can reuse the KV cache. The prompt prefix is immutable: [system] → [research] → [plan] → [step reports]. Ephemeral work (command output, current logs) is always appended at the very end of the prompt and compacted after every phase.

Phase data is not stored in files: you write each phase between markers directly in your message, and the extension extracts the blocks with a regex and builds the post-compaction prefix from them. The last occurrence of each block type wins: when updating a phase, write the FULL new version between new markers. A new RESEARCH or PLAN block starts a new task cycle: all STEP-N reports standing before it in the conversation are discarded automatically.

Markers (write the tokens exactly; close every block with its END marker):
- research:   /*STRATA::RESEARCH::v1*/ … /*STRATA::END::RESEARCH::v1*/
- plan:       /*STRATA::PLAN::v1*/ … /*STRATA::END::PLAN::v1*/
- step N report: /*STRATA::STEP-N::v1*/ … /*STRATA::END::STEP-N::v1*/

The pipeline only starts when the user gives a task. If they ask a question, clarify, or discuss something — just answer: no research and no plan are needed for that.

Pipeline:
1. Clarify the requirements with the user until the task is fully pinned down.
2. Pin the task: write the research report between the RESEARCH markers. Start it with a concise summary of the task as received from the user (their goal, requested outcome, and any explicit constraints), then record stack, architecture, inputs, constraints, and acceptance criteria.
3. Plan: write an atomic TODO list between the PLAN markers, one action per line in the format "- action". Each plan item must be a self-contained instruction: after compaction the step is executed from its own item without re-reading the history, so record enough detail in it (which files/modules are touched, exactly what to do, verification commands, expected outcome) so the task can be completed relying only on the plan and the reports. Then call strata with action="advance" — the first compaction happens at the end of the turn.
4. Execute steps one at a time. After each completed step (code + checks), write only the step N report between the STEP-N markers — 10-30 lines: what was done, which files changed, test/build results, key decisions, risks. Then call strata with action="advance" and step=N. The raw step context is saved to ${p.tmp}/step_N_raw.md during compaction — mention that in the report.
5. After each step call strata with action="advance" and step=N (the number of the completed step) — compaction at the end of the turn.
6. The reports are the primary information store for the following steps: do not omit key facts.

Rules:
- The marker blocks in the summary after compaction are the current layer state: do not repeat them unchanged; write new blocks only when a phase is updated.
- Keep the plan as written. Record completed work in the corresponding STEP-N report.
- New task: when the user gives the next task after a plan is complete, start the cycle again — write a fresh RESEARCH report and a new PLAN; the previous task's step reports are dropped automatically, so the new cycle starts with a clean step history and you must not rely on the old step reports.
- Unclosed marker blocks are dropped — close every block with its END marker before calling advance.
- Do not hand-edit the summary after compaction — the extension generates it from the markers.`;
}

/**
 * True when the branch already carries LLM context: any session entry that
 * produces context messages (a message, a compaction summary, …). A
 * mid-session system-prompt change in that case would invalidate the whole
 * KV-cache prefix and make the local model re-read the entire session.
 */
function branchHasContext(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  return branch.some(
    (entry) => sessionEntryToContextMessages(entry as never).length > 0,
  );
}

/**
 * The standing instructions delivered by /strata-on in a session that already
 * has context: a short activation notice plus the exact layer-0 body (kept
 * byte-identical to buildStrataInstructions, so after the system prompt picks
 * the instructions up the model sees the same protocol it followed before).
 */
export function buildStrataActivationMessage(strataDir: string): string {
  return (
    "[pi-strata] Layered-context mode is now ON for this session (enabled via /strata-on). " +
    "The standing instructions below apply to every turn of this session; after the next " +
    `compaction they move into the system prompt and this message is dropped.\n\n` +
    buildStrataInstructions(strataDir)
  );
}

/**
 * Conversation text for marker extraction: the last compaction summary (the
 * state at the last compaction) followed by the assistant messages after it,
 * in order — so "latest wins" extraction sees the summary first and newer
 * blocks in the tail override it.
 */
function branchText(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  let cut = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      cut = i;
      break;
    }
  }
  const parts: string[] = [];
  if (cut >= 0) {
    const entry = branch[cut];
    if (entry.type === "compaction" && typeof entry.summary === "string")
      parts.push(entry.summary);
  }
  for (let i = cut + 1; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    // SAFETY: AgentMessage is a pi-ai union type; here only the assistant
    // text is needed, and every text-carrying variant has {role, content}.
    const msg = entry.message as unknown as {
      role?: string;
      content?: unknown;
    };
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const c of content as { type?: string; text?: string }[]) {
        if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.join(SEP);
}

// ---------------------------------------------------------------------------
// Tool actions
// ---------------------------------------------------------------------------

function planAdvanceError(layers: StrataLayers): string | null {
  if (!layers.plan)
    return "Error: no PLAN block. Write the TODO list between /*STRATA::PLAN::v1*/ … /*STRATA::END::PLAN::v1*/ and call advance again.";
  if (parsePlan(layers.plan).length === 0)
    return 'Error: the PLAN block has no items (format "- action").';
  return null;
}

function stepAdvanceError(layers: StrataLayers, n: number): string | null {
  const items = layers.plan ? parsePlan(layers.plan) : [];
  if (items.length === 0)
    return "Error: no PLAN block. Write the TODO list between the PLAN markers and call advance again.";
  if (n > items.length)
    return `Error: the plan has ${items.length} item(s); there is no step ${n}.`;
  if (
    items
      .slice(0, n - 1)
      .some(
        (_item, index) =>
          !(layers.reports ?? []).some((report) => report.n === index + 1),
      )
  )
    return `Error: complete the preceding plan items first: their STEP-N reports are missing.`;
  if (!(layers.reports ?? []).some((r) => r.n === n))
    return `Error: no report for step ${n}. Write it between /*STRATA::STEP-${n}::v1*/ … /*STRATA::END::STEP-${n}::v1*/ and call advance again.`;
  return null;
}

/**
 * advance — the model has just written the phase block(s); queue the
 * end-of-turn compaction. Validates the blocks against the conversation so a
 * forgotten marker fails fast with a fix-it message instead of compacting
 * the wrong prefix.
 */
function actAdvance(
  rt: StrataRuntime,
  ctx: ExtensionContext,
  step?: number,
): ToolResult {
  const layers = extractLayers(branchText(ctx));
  if (!layers)
    return toolText(
      "Error: no STRATA:: blocks in the conversation. Write the phase between markers (RESEARCH/PLAN/STEP-N) and call advance again.",
      true,
    );

  if (step === undefined) {
    const err = planAdvanceError(layers);
    if (err) return toolText(err, true);
    const plan = layers.plan as string;
    rt.pending = { kind: "plan" };
    return toolText(
      `First compaction at the end of the turn. Next: execute step 1 ("${itemText(plan, 0)}"); after each step call strata(action="advance", step=N).`,
    );
  }

  const n = Math.trunc(step);
  if (!Number.isFinite(n) || n < 1)
    return toolText("Error: step must be an integer >= 1.", true);
  const err = stepAdvanceError(layers, n);
  if (err) return toolText(err, true);
  rt.pending = { kind: "step", stepN: n };
  const tmpDir = rt.strataDir ? strataPaths(rt.strataDir).tmp : "(no session)";
  const nextIdx = firstUnreportedPlanStep(
    layers.plan as string,
    layers.reports ?? [],
  );
  const tail =
    nextIdx >= 0
      ? ` Next step: "${itemText(layers.plan as string, nextIdx)}".`
      : " All plan steps are complete.";
  return toolText(
    `Step ${n} accepted. Compaction at the end of the turn (raw context → ${tmpDir}/step_${n}_raw.md).${tail}`,
  );
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Config: env (PI_STRATA_*) > settings.json `piStrata` > defaults.
  // Resolved at load time from process.cwd(); re-resolved on session_start
  // with the real project cwd.
  const initial = resolveStrataSettings(process.cwd());
  const rt: StrataRuntime = {
    strataDir: null,
    pending: null,
  };
  // The strata mode is SESSION state, not a setting: off by default, enabled
  // for the session with /strata-on. It is not persisted anywhere — a session
  // (re)start or /reload begins with it off again. There is deliberately no
  // in-session off command: off is the session default.
  let enabled = false;
  // KV-cache guard: when /strata-on enables the mode in a session that
  // already carries context, the system prompt must not change immediately
  // (that would invalidate the whole cached prefix). The layer-0
  // instructions are delivered as a message at the end of the context
  // instead, and the system prompt picks them up only after the next
  // compaction — which rewrites the context anyway (session_compact lifts
  // the deferral). Fresh sessions take the immediate path (nothing to
  // protect).
  let deferSystemPrompt = false;
  let autoContinue = initial.autoContinue;
  let hideAnchors = initial.hideAnchors;
  // Set by the session_before_compact handler: did the LAST before-compact
  // event return a strata compaction result? Used by session_compact to
  // detect when another extension's result replaced ours (pi keeps the
  // result of the last-loaded handler — there is no merge).
  let compactOurs = false;

  // Compact TUI rendering for the standing-instructions message
  // (INSTRUCTIONS_CUSTOM_TYPE): one line by default, expandable to the full
  // text — the raw instructions are long and would flood the transcript.
  pi.registerMessageRenderer(
    INSTRUCTIONS_CUSTOM_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const line =
        expanded && typeof message.content === "string"
          ? message.content
          : `${theme.fg("accent", "strata")} ${theme.fg(
              "dim",
              "standing instructions attached (move to the system prompt after the next compaction)",
            )}`;
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(line, 0, 0));
      return box;
    },
  );

  // Display-only: hide the STRATA marker anchors in the TUI transcript
  // (config hideAnchors, default on; re-resolved on session_start). pi's
  // markdown transformer runs before rendering (assistant text and
  // thinking, streaming and final, new and restored messages); the session
  // and the model context keep the raw markers, so extraction is
  // unaffected. User messages are passed through untouched.
  pi.registerMarkdownTransformer((markdown, { messageType }) =>
    hideAnchors && messageType !== "user"
      ? stripStrataMarkersForDisplay(markdown)
      : markdown,
  );

  const statusText = (ctx: ExtensionContext): string => {
    const dir = rt.strataDir ?? "(no session)";
    const layers = extractLayers(branchText(ctx));
    const plan = layers?.plan;
    const reports = layers?.reports ?? [];
    const counts = plan
      ? reportPlanCounts(plan, reports)
      : { done: 0, total: 0 };
    const nextIdx = plan ? firstUnreportedPlanStep(plan, reports) : -1;
    let next = "no plan";
    if (counts.total > 0) {
      next =
        nextIdx >= 0
          ? `next: #${nextIdx + 1} ${itemText(plan as string, nextIdx)}`
          : "all done";
    }
    const reportNumbers = reports.map((r) => r.n);
    let pending = "none";
    if (rt.pending)
      pending =
        rt.pending.kind === "step"
          ? `step:${rt.pending.stepN}`
          : rt.pending.kind;
    return [
      `dir: ${dir}`,
      `enabled: ${enabled ? "on" : "off"}`,
      `sysprompt: ${deferSystemPrompt ? "deferred (next compaction)" : "active"}`,
      `research: ${layers?.research ? "yes" : "no"}`,
      `plan: ${counts.done}/${counts.total} (${next})`,
      `reports: [${reportNumbers.join(",")}]`,
      `settings: auto=${autoContinue ? "on" : "off"} anchors=${hideAnchors ? "hidden" : "shown"}`,
      `pending: ${pending}`,
    ].join(" | ");
  };

  // pi-lens-style widget rendering: paint the themeable segments with the
  // current theme and fit the single line to the terminal width (widgets
  // must not wrap). The setWidget factory is invoked on every update, so
  // the captured segments are always fresh; render() only applies colors.
  const renderSegments = (
    segments: WidgetSegment[],
    theme: Theme,
    width: number,
  ): string[] => {
    const paint = (seg: WidgetSegment): string => {
      if (seg.color === undefined) return seg.text;
      return theme.fg(seg.color, seg.text);
    };
    return [fitLine(segments.map(paint).join(""), width)];
  };

  // Keeps both strata widgets in sync (call this whenever the conversation
  // or the mode can have changed).
  const updateWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const layers = extractLayers(branchText(ctx));
    // The plan dashboard (above the editor) is a strata-session feature:
    // hidden while the mode is off (and for non-strata sessions, as before).
    // One line, e.g.:  strata  2/5 ✓✓▶··  next: #3 install deps
    const dashboard =
      enabled && layers
        ? planDashboardSegments(
            layers.plan,
            layers.reports ?? [],
            layers.research !== undefined,
          )
        : undefined;
    if (dashboard) {
      ctx.ui.setWidget("strata", (_tui, theme) => ({
        render: (width) => renderSegments(dashboard, theme, width),
        invalidate: () => {}, // stateless: render recomputes from captured segments
      }));
    } else {
      ctx.ui.setWidget("strata", undefined);
    }
    // Mode indicator (below the editor, pi-lens style): redundant while the
    // dashboard is visible — it already shows the strata state. Shown only
    // while the dashboard is hidden, so the session default (off) or an
    // explicit /strata-on is never a surprise.
    if (dashboard) {
      ctx.ui.setWidget("strata-mode", undefined);
    } else {
      const segments = modeSegments(enabled);
      ctx.ui.setWidget(
        "strata-mode",
        (_tui, theme) => ({
          render: (width) => renderSegments(segments, theme, width),
          invalidate: () => {}, // stateless: render recomputes from captured segments
        }),
        { placement: "belowEditor" },
      );
    }
  };

  const autoContinueNext = (ctx: ExtensionContext): void => {
    try {
      const plan = extractLayers(branchText(ctx))?.plan;
      if (!plan) return;
      const idx = firstUnreportedPlanStep(
        plan,
        extractLayers(branchText(ctx))?.reports ?? [],
      );
      if (idx === -1) {
        if (ctx.hasUI)
          ctx.ui.notify("pi-strata: all plan steps completed", "info");
        return;
      }
      pi.sendUserMessage(
        `PI-STRATA: continue — execute step ${idx + 1}: "${itemText(plan, idx)}".`,
      );
    } catch {
      // non-fatal: user can continue manually
    }
  };

  const requestCompact = (
    ctx: ExtensionContext,
    customInstructions: string,
    onDone?: () => void,
  ): void => {
    if (ctx.hasUI)
      ctx.ui.notify(`pi-strata: compacting… (${customInstructions})`, "info");
    ctx.compact({
      customInstructions,
      onComplete: () => {
        if (ctx.hasUI) ctx.ui.notify("pi-strata: compaction finished", "info");
        onDone?.();
      },
      onError: (err) => {
        // Pi rejects a manual compaction before invoking
        // `session_before_compact` when the whole branch fits inside its
        // `compaction.keepRecentTokens` budget. Do not leave a phase request
        // pending in that case: a stale pending marker would be consumed by
        // the next unrelated compaction and mislabel it as a step/plan dump.
        rt.pending = null;
        if (ctx.hasUI)
          ctx.ui.notify(
            err.message === "Nothing to compact (session too small)"
              ? "pi-strata: Pi deferred compaction: the session fits in compaction.keepRecentTokens. The phase remains in context; the compaction will be retried at the next advance."
              : `pi-strata: compaction failed: ${err.message}`,
            "error",
          );
      },
    });
  };

  // ------------------------------------------------------------------ events

  pi.on("session_start", (_event, ctx) => {
    const s = resolveStrataSettings(ctx.cwd);
    // The mode is session state: every (re)started session begins off; the
    // user opts in with /strata-on (nothing is persisted).
    enabled = false;
    deferSystemPrompt = false;
    autoContinue = s.autoContinue;
    hideAnchors = s.hideAnchors;

    rt.strataDir = resolveStrataDir(ctx);
    rt.pending = null;
    compactOurs = false;

    // pi fires no "session deleted" event: collect orphaned strata dirs of
    // sessions whose .jsonl is gone (session picker or manual deletion).
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      const removed = cleanupOrphanedStrataDirs(dirname(sessionFile));
      if (removed > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `pi-strata: removed strata dirs of deleted sessions: ${removed}`,
          "info",
        );
      }
    }

    // Off is the normal session default: stay silent unless the session
    // already carries strata layers (a resumed/forked strata session — there
    // are no files to rehydrate, the layers live in the conversation) — then
    // point at /strata-on and announce the layer state.
    const layers = extractLayers(branchText(ctx));
    if (ctx.hasUI && layers && (layers.research || layers.plan)) {
      ctx.ui.notify(
        `pi-strata: strata layers found in the session, mode is off (session default) — /strata-on re-enables the pipeline. ${statusText(ctx)}`,
        "info",
      );
    }
    updateWidget(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    // `/reload` replaces the extension runtime without replaying
    // `session_start` for the already open session. Rehydrate the only
    // session-scoped value lazily so the next turn still receives strata
    // instructions and can intercept compaction.
    if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
    if (!enabled) return; // disabled: no layer-0 instructions this turn
    if (deferSystemPrompt) {
      // KV-cache guard: the standing instructions ride on the injected
      // message until the next compaction (session_compact lifts the
      // deferral) — changing the system prompt here would invalidate the
      // whole cached prefix and make the model re-read the session.
      return;
    }
    const instructions = buildStrataInstructions(rt.strataDir);
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    // Compaction can also be the first event after `/reload` (for example an
    // automatic overflow compaction), before another agent turn has started.
    if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
    if (!enabled) {
      // Disabled: fall back to pi's default compaction. Drop any stale
      // phase request so it cannot be consumed by a later compaction.
      rt.pending = null;
      return;
    }
    const result = await handleSessionBeforeCompact(event, ctx, rt);
    compactOurs = result?.compaction !== undefined;
    return result;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
    const pending = rt.pending;
    if (!pending) return;
    if (!enabled) {
      // Disabled mid-phase: drop the request, no strata compaction.
      rt.pending = null;
      return;
    }
    // Do not consume `pending` here. `ctx.compact()` starts asynchronously and
    // `session_before_compact` needs this marker to build a plan/step summary
    // (and to save the correct raw snapshot). It consumes the marker only
    // after Pi has prepared a real compaction.
    if (pending.kind === "step") {
      requestCompact(ctx, `step:${pending.stepN}`, () => {
        if (autoContinue) autoContinueNext(ctx);
      });
    } else {
      requestCompact(ctx, "plan");
    }
  });

  // The plan/reports live in the conversation, so every finished turn (and
  // every compaction) can change what the dashboard shows.
  pi.on("turn_end", (_event, ctx) => {
    updateWidget(ctx);
  });

  pi.on("session_compact", (event, ctx) => {
    updateWidget(ctx);
    // The compaction just rewrote the context: swapping the system prompt now
    // costs no cached prefix, so lift the KV-cache deferral — from the next
    // turn on the layer-0 instructions live in the system prompt (the
    // injected message is consumed by this or the next compaction).
    if (deferSystemPrompt) {
      deferSystemPrompt = false;
      if (ctx.hasUI)
        ctx.ui.notify(
          "pi-strata: layer-0 instructions moved to the system prompt",
          "info",
        );
    }
    if (!ctx.hasUI) return;
    const details = event.compactionEntry.details as StrataDetails | undefined;
    if (details?.strata) {
      ctx.ui.notify(
        `pi-strata: layers compacted (${details.strata.mode}${
          details.strata.llmSummary ? ", + pi summary" : ""
        })`,
        "info",
      );
    } else if (compactOurs) {
      // We returned a strata result but the saved entry does not carry our
      // details.strata marker: another extension's session_before_compact
      // handler (loaded after pi-strata) replaced it — or, when pi's default
      // ran, our result was dropped. Either way the layers are not preserved.
      const cause = event.fromExtension
        ? "another extension's session_before_compact handler (loaded after pi-strata) replaced it"
        : "pi's default summarization ran instead";
      ctx.ui.notify(
        `pi-strata: the strata summary was not used (${cause}); the strata layers are not preserved in this summary. If several extensions handle compaction, keep only one or load pi-strata last.`,
        "warning",
      );
    }
  });

  // -------------------------------------------------------------------- tool

  const StrataParams = Type.Object({
    action: StringEnum(["advance", "status"] as const),
    step: Type.Optional(
      Type.Number({
        description:
          "action=advance: number of the completed step (N from the STEP-N marker). Omit for the first compaction after the plan.",
      }),
    ),
  });

  pi.registerTool({
    name: "strata",
    label: "Strata",
    description:
      'pi-strata: advances the layered-context phases (KV-cache). After writing a phase between STRATA:: markers, call strata(action="advance") — compaction at the end of the turn; with step=N — after completed step N. status — current layer state.',
    parameters: StrataParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "advance":
          if (!enabled)
            return toolText(
              "Error: pi-strata is disabled. Run /strata-on to enable it for this session, then call advance again.",
              true,
            );
          return actAdvance(rt, ctx, params.step);
        case "status":
          return toolText(statusText(ctx));
        default:
          return toolText("Error: unknown strata action.", true);
      }
    },
  });

  // ----------------------------------------------------------------- command

  pi.registerCommand("strata", {
    description:
      "pi-strata: layer status; /strata compact — forced compaction; /strata reset — delete raw snapshots (tmp/); /strata-on — enable the mode for this session",
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim().toLowerCase();

      if (cmd === "compact") {
        await ctx.waitForIdle();
        requestCompact(ctx, "manual");
        return;
      }

      if (cmd !== "reset") {
        ctx.ui.notify(`pi-strata: ${statusText(ctx)}`, "info");
        updateWidget(ctx);
        return;
      }

      if (!ctx.hasUI || !rt.strataDir) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "pi-strata: reset is only available in interactive mode",
            "error",
          );
        return;
      }
      const ok = await ctx.ui.confirm(
        "pi-strata",
        "Delete the raw context snapshots of this session (tmp/)?",
      );
      if (!ok) return;
      rmSync(strataPaths(rt.strataDir).tmp, { recursive: true, force: true });
      ctx.ui.notify("pi-strata: snapshots cleared", "info");
    },
  });

  // /strata-on — enable the strata mode for THIS session only. Session-
  // scoped by design: off by default, nothing is persisted (a session
  // (re)start or /reload begins off again). Once on: the layer-0 instructions
  // are appended to the system prompt and strata compaction is intercepted.
  // There is deliberately no in-session off command — off is the default.
  pi.registerCommand("strata-on", {
    description:
      "pi-strata: enable layered-context mode for this session (off by default; not persisted)",
    // async: pi's command handler type is Promise<void> even though the
    // work below is synchronous.
    handler: async (_args, ctx) => {
      if (enabled) {
        if (ctx.hasUI) ctx.ui.notify("pi-strata: already on", "info");
        return;
      }
      if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
      enabled = true;
      rt.pending = null; // a stale phase request must not outlive the switch
      // KV-cache guard: in a session that already carries context, changing
      // the system prompt now would invalidate the whole cached prefix and
      // make the local model re-read the entire session. Deliver the layer-0
      // instructions as a standing message appended at the end of the
      // context instead; the next compaction rewrites the context anyway, so
      // the system prompt picks them up then (session_compact lifts the
      // deferral). A fresh session takes the immediate path (nothing to
      // protect).
      deferSystemPrompt = branchHasContext(ctx);
      updateWidget(ctx);
      const layers = extractLayers(branchText(ctx));
      const hasLayers = Boolean(layers && (layers.research || layers.plan));
      if (deferSystemPrompt) {
        pi.sendMessage(
          {
            customType: INSTRUCTIONS_CUSTOM_TYPE,
            content: buildStrataActivationMessage(rt.strataDir),
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
        // Resumed/forked strata sessions re-announce the layer state, as
        // before; plain sessions get the generic notice only.
        if (ctx.hasUI)
          ctx.ui.notify(
            `pi-strata: enabled — standing instructions queued at the end of the context; the system prompt picks them up after the next compaction (KV cache preserved).${hasLayers ? ` ${statusText(ctx)}` : ""}`,
            "info",
          );
        return;
      }
      if (!ctx.hasUI) return;
      if (hasLayers) {
        // Session already carries strata layers (resumed/forked): re-announce
        // the current state instead of a generic notice.
        ctx.ui.notify(`pi-strata: ${statusText(ctx)}`, "info");
      } else {
        ctx.ui.notify(
          "pi-strata: enabled — layer-0 instructions and strata compaction are on for this session",
          "info",
        );
      }
    },
  });
}
