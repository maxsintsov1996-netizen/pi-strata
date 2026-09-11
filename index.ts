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
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
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
  firstUnreportedPlanStep,
  itemText,
  parsePlan,
  reportPlanCounts,
  strataPaths,
  type StrataLayers,
} from "./strata.ts";

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

Phase data is not stored in files: you write each phase between markers directly in your message, and the extension extracts the blocks with a regex and builds the post-compaction prefix from them. The last occurrence of each block type wins: when updating a phase, write the FULL new version between new markers.

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
- Unclosed marker blocks are dropped — close every block with its END marker before calling advance.
- Do not hand-edit the summary after compaction — the extension generates it from the markers.`;
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
  let autoContinue = initial.autoContinue;
  // Set by the session_before_compact handler: did the LAST before-compact
  // event return a strata compaction result? Used by session_compact to
  // detect when another extension's result replaced ours (pi keeps the
  // result of the last-loaded handler — there is no merge).
  let compactOurs = false;

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
      `research: ${layers?.research ? "yes" : "no"}`,
      `plan: ${counts.done}/${counts.total} (${next})`,
      `reports: [${reportNumbers.join(",")}]`,
      `settings: auto=${autoContinue ? "on" : "off"}`,
      `pending: ${pending}`,
    ].join(" | ");
  };

  // Persistent plan-execution dashboard (widget above the editor).
  // One line, e.g.:  strata ▸ 2/5 ✓✓▶··  next: #3 install deps
  const planWidgetLines = (ctx: ExtensionContext): string[] | undefined => {
    const layers = extractLayers(branchText(ctx));
    if (!layers) return undefined; // not a strata session — hide the widget
    if (!layers.plan) {
      return [
        `strata ▸ ${layers.research ? "research done — plan pending" : "pre-plan"}`,
      ];
    }
    const plan = layers.plan;
    const reports = layers.reports ?? [];
    const total = parsePlan(plan).length;
    const completed = new Set<number>();
    for (const r of reports) if (r.n >= 1 && r.n <= total) completed.add(r.n);
    const done = completed.size;
    const nextIdx = firstUnreportedPlanStep(plan, reports);
    const bar = parsePlan(plan)
      .map((_item, i) => {
        if (completed.has(i + 1)) return "✓";
        return i === nextIdx ? "▶" : "·";
      })
      .join("");
    const next =
      nextIdx >= 0
        ? `next: #${nextIdx + 1} ${itemText(plan, nextIdx)}`
        : "all steps completed";
    return [`strata ▸ ${done}/${total} ${bar}  ${next}`];
  };

  const updateWidget = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setWidget("strata", planWidgetLines(ctx));
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
    autoContinue = s.autoContinue;

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

    // Re-announce the layer state extracted from the conversation
    // (fork/clone friendly: there are no files to rehydrate anymore).
    const layers = extractLayers(branchText(ctx));
    if (layers && (layers.research || layers.plan) && ctx.hasUI) {
      ctx.ui.notify(`pi-strata: ${statusText(ctx)}`, "info");
    }
    updateWidget(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    // `/reload` replaces the extension runtime without replaying
    // `session_start` for the already open session. Rehydrate the only
    // session-scoped value lazily so the next turn still receives strata
    // instructions and can intercept compaction.
    if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
    const instructions = buildStrataInstructions(rt.strataDir);
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    // Compaction can also be the first event after `/reload` (for example an
    // automatic overflow compaction), before another agent turn has started.
    if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
    const result = await handleSessionBeforeCompact(event, ctx, rt);
    compactOurs = result?.compaction !== undefined;
    return result;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rt.strataDir) rt.strataDir = resolveStrataDir(ctx);
    const pending = rt.pending;
    if (!pending) return;
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
      "pi-strata: layer status; /strata compact — forced compaction; /strata reset — delete raw snapshots (tmp/)",
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
}
