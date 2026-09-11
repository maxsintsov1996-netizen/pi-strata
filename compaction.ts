/**
 * pi-strata — compaction integration (SPEC §3, §4, §5).
 *
 * session_before_compact handler that turns every compaction of a strata
 * session into a deterministic layer dump:
 *
 *   prompt after compaction = [system prompt] + [strata summary] + [kept tail]
 *
 * The strata summary is built ONLY from the marker blocks extracted from the
 * conversation — previous compaction summary first, then the messages about
 * to be discarded (latest block of each phase wins) — re-emitted in fixed
 * order with strict "\n\n" separators, so the prefix
 * [system + summary] is byte-stable across consecutive compactions and the
 * llama.cpp KV cache survives. No layer files exist: the conversation itself
 * is the storage (SPEC §2). The ephemeral span is serialized to a raw
 * snapshot in <strata>/tmp/ BEFORE the summary is returned.
 *
 * Modes:
 *  - "step":    a step was just completed (strata tool advance, pending set) —
 *               snapshot + drop any WIP block (replaced by the step report);
 *  - "plan":    first compaction, after the plan was written (advance) —
 *               plain dump, wins over the WIP heuristic;
 *  - "wip":     compaction while research or a step is unfinished (context
 *               threshold / overflow) — generate a WIP report with the local
 *               LLM and keep only the last `keepWipTokens` (SPEC §5: 10000);
 *  - "plain":   post-completion or otherwise unmarked compactions — no extras.
 */

import {
  convertToLlm,
  findCutPoint,
  serializeConversation,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { join } from "node:path";
import {
  SEP,
  STRATA_VERSION,
  buildStrataSummary,
  extractLayers,
  firstUnreportedPlanStep,
  normalizeText,
  strataPaths,
  writeSnapshot,
  type StrataLayers,
} from "./strata.ts";

export interface StrataRuntime {
  /** Session strata directory (resolved at session_start), or null before that. */
  strataDir: string | null;
  /** Step/plan compaction queued by the strata tool; fired on agent_settled. */
  pending: { kind: "plan" | "step"; stepN?: number } | null;
  /** Tokens to keep on top of the WIP report (SPEC §5: 10000). */
  keepWipTokens: number;
  /** Remaining-context percentage that arms WIP compaction (SPEC §5: 20). */
  wipRemainingThresholdPct: number;
}

export interface StrataDetails {
  strata: {
    mode: "plan" | "step" | "wip" | "plain";
    version: string;
    stepN?: number;
    reportFiles: number[];
    hasWip: boolean;
    /** Phase interrupted by the WIP compaction, if applicable. */
    wipPhase?: "research" | "step";
  };
}

const WIP_MAX_TAIL_CHARS = 60_000;
const WIP_MIN_TAIL_CHARS = 4_000;
const WIP_MAX_OUTPUT_TOKENS = 1500;

const WIP_PROMPT_STATIC = `You are the WIP (work in progress) report editor for a coding agent. Write a compact report about the unfinished phase so that after context compaction the agent can resume work seamlessly. The phase is either research/information gathering before a plan exists, or execution of a plan step.

Format (strict, at most ~40 lines):
## Current Task
What is being done right now (1-3 lines).
## Progress
What is already established in the unfinished research or current step (compact list).
## Files
Files read/modified and why (compact list).
## Next Action
The exact next action to finish the research or step.

Technical facts only, no meta-comments or apologies.`;

type SessionEntryLike = { id: string; type: string; firstKeptEntryId?: string };

/**
 * Compute the id of the first entry to keep so that the kept tail is about
 * `keepTokens` (mirrors pi's own prepareCompaction boundary walk).
 */
function keptEntryIdForTokens(
  branchEntries: readonly unknown[],
  keepTokens: number,
  fallbackId: string,
): string {
  const entries = branchEntries as readonly SessionEntryLike[];
  let boundaryStart = 0;
  let prev = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") {
      prev = i;
      break;
    }
  }
  if (prev >= 0) {
    const fk = entries[prev].firstKeptEntryId;
    const idx = entries.findIndex((e) => e.id === fk);
    boundaryStart = idx >= 0 ? idx : prev + 1;
  }
  const cut = findCutPoint(
    entries as never[],
    boundaryStart,
    entries.length,
    keepTokens,
  );
  const entry = entries[cut.firstKeptEntryIndex];
  return entry?.id ?? fallbackId;
}

/** Budget the WIP prompt to fit small local models (chars ≈ 4 tokens). */
function wipTailBudget(modelContextWindow: number): number {
  return Math.min(
    WIP_MAX_TAIL_CHARS,
    Math.max(WIP_MIN_TAIL_CHARS, modelContextWindow * 2),
  );
}

function wipOutputBudget(modelContextWindow: number): number {
  return Math.min(
    WIP_MAX_OUTPUT_TOKENS,
    Math.max(256, Math.floor(modelContextWindow / 8)),
  );
}

/**
 * Generate the WIP report with the active (local) model. Falls back to a
 * deterministic digest when the call fails; rethrows on abort so the
 * compaction itself is cancelled cleanly.
 */
function deterministicWipFallback(serialized: string): string {
  return normalizeText(
    [
      "## Current Task",
      "Unfinished research or step (LLM summarization unavailable — details in the raw snapshot).",
      "",
      "## Progress",
      "- see raw context (tmp/wip_raw.md)",
      "",
      "## Next Action",
      "- resume the interrupted research or step",
      "",
      "## Raw tail",
      serialized.slice(-2000),
    ].join("\n"),
  );
}

async function generateWipReport(
  ctx: ExtensionContext,
  layers: StrataLayers,
  serialized: string,
  signal: AbortSignal,
): Promise<string> {
  const model = ctx.model;
  if (!model) return deterministicWipFallback(serialized);

  const budget = wipTailBudget(model.contextWindow);
  const tail =
    serialized.length > budget
      ? "…[earlier context omitted]…\n" + serialized.slice(-budget)
      : serialized;
  const base = buildStrataSummary({ ...layers, wip: undefined });
  const prompt = [
    WIP_PROMPT_STATIC,
    `## Project context (immutable layers)\n${base}`,
    `## Conversation since the last compaction\n${tail}`,
  ].join(SEP);

  try {
    const res = await ctx.modelRegistry.complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: wipOutputBudget(model.contextWindow),
        signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
      },
    );
    const text = res.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (text.trim()) return normalizeText(text);
    throw new Error("empty WIP summary");
  } catch (err) {
    if (signal.aborted) throw err;
    return deterministicWipFallback(serialized);
  }
}

/** Shape of session_before_compact handler result (structural match with pi's type). */
export type BeforeCompactResult = {
  cancel?: boolean;
  compaction?: CompactionResult<StrataDetails>;
};

/**
 * session_before_compact handler. Returns undefined when the session is not
 * a strata session (lets pi's default compaction run).
 */
export async function handleSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  rt: StrataRuntime,
): Promise<BeforeCompactResult | undefined> {
  const dir = rt.strataDir;
  if (!dir) return undefined;

  const p = strataPaths(dir);
  const { preparation, branchEntries, signal } = event;

  const messagesToDiscard = [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ];
  const discardedSerialized = serializeConversation(
    convertToLlm(messagesToDiscard),
  );

  // `preparation` deliberately excludes Pi's kept tail. Marker blocks are
  // often recent (especially the PLAN written just before work starts), so
  // looking only at the discarded span can make a live strata session appear
  // unmarked and skip WIP entirely. Include that tail for layer extraction and
  // raw snapshots; it stays newer than both the previous summary and the
  // discarded span, preserving the usual "latest wins" semantics.
  const firstKeptIndex = branchEntries.findIndex(
    (entry: { id: string }) => entry.id === preparation.firstKeptEntryId,
  );
  const keptMessages =
    firstKeptIndex < 0
      ? []
      : branchEntries
          .slice(firstKeptIndex)
          .flatMap((entry) => sessionEntryToContextMessages(entry as never));
  const keptSerialized = serializeConversation(convertToLlm(keptMessages));
  const serialized = [discardedSerialized, keptSerialized]
    .filter((text) => text.length > 0)
    .join(SEP);

  // The conversation is the layer storage: previous summary (state at the
  // last compaction) first, then the span about to be discarded — the latest
  // block of each phase wins.
  const sourceText = preparation.previousSummary
    ? `${preparation.previousSummary}${SEP}${serialized}`
    : serialized;
  const layers = extractLayers(sourceText);

  // No marker blocks at all — not a strata session: keep default compaction.
  if (!layers) return undefined;

  let firstKept = preparation.firstKeptEntryId;
  let mode: "plan" | "step" | "wip" | "plain";
  let stepN: number | undefined;
  let wipPhase: "research" | "step" | undefined;

  if (rt.pending?.kind === "step") {
    // Step just completed: snapshot the ephemeral span, drop the WIP block
    // (replaced by the step report, SPEC §5), keep pi's default tail.
    mode = "step";
    stepN = rt.pending.stepN;
    writeSnapshot(
      join(p.tmp, `step_${stepN ?? 0}_raw.md`),
      `step ${stepN}`,
      serialized,
    );
    layers.wip = undefined;
  } else if (rt.pending?.kind === "plan") {
    // First compaction, after the plan was written (advance) — wins over the
    // WIP heuristic even when the plan is fully open. A research WIP is now
    // superseded by the completed research + plan layers.
    mode = "plan";
    layers.wip = undefined;
  } else {
    const hasUnfinishedStep =
      layers.plan !== undefined &&
      firstUnreportedPlanStep(layers.plan, layers.reports ?? []) !== -1;
    // Research starts as soon as its marker block exists. Until a PLAN block
    // is written, its findings are still being gathered and need the same WIP
    // protection as an unfinished implementation step.
    const hasUnfinishedResearch = layers.research !== undefined && !layers.plan;
    if (hasUnfinishedStep || hasUnfinishedResearch) {
      // Mid-phase compaction (threshold / overflow / manual): WIP report on
      // top of the layers + keep only the last keepWipTokens (SPEC §5).
      mode = "wip";
      wipPhase = hasUnfinishedResearch ? "research" : "step";
      writeSnapshot(join(p.tmp, "wip_raw.md"), `WIP (${wipPhase})`, serialized);
      layers.wip = await generateWipReport(ctx, layers, serialized, signal);
      firstKept = keptEntryIdForTokens(
        branchEntries,
        rt.keepWipTokens,
        preparation.firstKeptEntryId,
      );
    } else {
      mode = "plain";
    }
  }

  const summary = buildStrataSummary(layers);
  const details: StrataDetails = {
    strata: {
      mode,
      version: STRATA_VERSION,
      stepN,
      reportFiles: (layers.reports ?? []).map((r) => r.n),
      hasWip: layers.wip !== undefined,
      wipPhase,
    },
  };

  // `ctx.compact()` is asynchronous. Keep the request marker alive until this
  // hook consumes it: clearing it from `agent_settled` makes every requested
  // plan/step compaction look like an ordinary WIP/plain compaction.
  if (rt.pending) rt.pending = null;

  return {
    compaction: {
      summary,
      firstKeptEntryId: firstKept,
      tokensBefore: preparation.tokensBefore,
      details,
    },
  };
}
