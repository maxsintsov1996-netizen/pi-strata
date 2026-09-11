/**
 * pi-strata — compaction integration (SPEC §3, §4, §5).
 *
 * session_before_compact handler for strata sessions:
 *
 *   prompt after compaction = [system prompt] + [strata summary] + [kept tail]
 *
 * The strata summary's layer blocks are built ONLY from the marker blocks
 * extracted from the conversation — previous compaction summary first, then
 * the messages about to be discarded (latest block of each phase wins) —
 * re-emitted in fixed order with strict "\n\n" separators, so the prefix
 * [system + layer blocks] is byte-stable across consecutive compactions and
 * the llama.cpp KV cache survives. No layer files exist: the conversation
 * itself is the storage (SPEC §2).
 *
 * Modes:
 *  - "step":  a step was just completed (strata tool advance, pending set) —
 *             snapshot the ephemeral span to <strata>/tmp/, deterministic
 *             layer dump;
 *  - "plan":  first compaction, after the plan was written (advance) —
 *             deterministic layer dump;
 *  - "plain": any other compaction (Pi's overflow / manual) — the layer
 *             blocks PLUS pi's standard LLM summarization of the ephemeral
 *             span on top of them, so in-flight work survives as a regular
 *             pi checkpoint. Fallback (no model / auth / LLM error): the
 *             deterministic layer dump alone.
 *
 * The LLM is never fed the layer blocks: pi's merge input is only its own
 * previous LLM tail (previousLlmTail), and the summarizer is instructed not
 * to restate the marker blocks it sees in the raw conversation.
 */

import {
  compact as piCompact,
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  SEP,
  STRATA_VERSION,
  buildStrataSummary,
  extractLayers,
  normalizeText,
  strataPaths,
  writeSnapshot,
} from "./strata.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];
type LlmResult = Pick<CompactionResult, "summary" | "usage">;

export interface StrataRuntime {
  /** Session strata directory (resolved at session_start), or null before that. */
  strataDir: string | null;
  /** Step/plan compaction queued by the strata tool; fired on agent_settled. */
  pending: { kind: "plan" | "step"; stepN?: number } | null;
}

export interface StrataDetails {
  strata: {
    mode: "plan" | "step" | "plain";
    version: string;
    stepN?: number;
    reportFiles: number[];
    /** Plain compaction: true when the summary also carries pi's LLM summary. */
    llmSummary: boolean;
  };
}

/** Shape of session_before_compact handler result (structural match with pi's type). */
export type BeforeCompactResult = {
  cancel?: boolean;
  compaction?: CompactionResult<StrataDetails>;
};

/**
 * Focus passed to pi's standard summarizer on plain (overflow / manual)
 * compactions: the strata sections are preserved by the extension, the LLM
 * must only cover the ephemeral span.
 */
const PLAIN_FOCUS =
  "The conversation contains pi-strata marker blocks (/*STRATA::...::v1*/ ... /*STRATA::END::...::v1*/) holding the task research, the plan, and the step reports. They are preserved separately by the extension and are NOT part of your summary: do not restate, quote, or duplicate them. Summarize only the ephemeral work outside those blocks: tool outputs, findings, in-progress file changes, errors, and decisions not yet recorded in a step report — enough to resume the interrupted work.";

/**
 * pi's standard summarization of the ephemeral span. Injectable for tests;
 * the default calls pi's own compact() with the session model's auth.
 */
export type PlainSummarizer = (
  preparation: Preparation,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<LlmResult>;

/** pi's headers allow null values; compact() does not. */
function cleanHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers))
    if (value !== null) out[key] = value;
  return out;
}

async function defaultPlainSummarizer(
  preparation: Preparation,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<LlmResult> {
  const model = ctx.model;
  if (!model) throw new Error("no model selected");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const result = await piCompact(
    preparation,
    model,
    auth.apiKey,
    cleanHeaders(auth.headers),
    PLAIN_FOCUS,
    signal,
    ctx.thinkingLevel,
    undefined,
    auth.env,
  );
  return { summary: result.summary, usage: result.usage };
}

/**
 * The non-strata part of the previous summary: the pi LLM tail of the last
 * plain compaction. The layer blocks are re-emitted byte-identically by the
 * extension and must not pass through the LLM again (that would break the
 * stable prefix); the LLM only merges its own previous tail with the new
 * ephemeral span (pi's UPDATE-prompt semantics). Non-strata summaries are
 * passed through untouched.
 */
export function previousLlmTail(
  previousSummary: string | undefined,
): string | undefined {
  if (!previousSummary) return undefined;
  const layers = extractLayers(previousSummary);
  if (layers) {
    const canonical = buildStrataSummary(layers);
    if (previousSummary.startsWith(canonical)) {
      const tail = normalizeText(previousSummary.slice(canonical.length));
      return tail === "" ? undefined : tail;
    }
  }
  return previousSummary;
}

/**
 * session_before_compact handler. Returns undefined when the session is not
 * a strata session (lets pi's default compaction run).
 */
export async function handleSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  rt: StrataRuntime,
  deps?: { summarizePlain?: PlainSummarizer },
): Promise<BeforeCompactResult | undefined> {
  const dir = rt.strataDir;
  if (!dir) return undefined;

  const p = strataPaths(dir);
  const { preparation, branchEntries } = event;
  const summarizePlain = deps?.summarizePlain ?? defaultPlainSummarizer;

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
  // unmarked and lose the layers. Include that tail for layer extraction and
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

  let mode: "plan" | "step" | "plain";
  let stepN: number | undefined;

  if (rt.pending?.kind === "step") {
    // Step just completed: snapshot the ephemeral span before it is
    // replaced by the step report, keep Pi's default tail.
    mode = "step";
    stepN = rt.pending.stepN;
    writeSnapshot(
      join(p.tmp, `step_${stepN ?? 0}_raw.md`),
      `step ${stepN}`,
      serialized,
    );
  } else if (rt.pending?.kind === "plan") {
    // First compaction, after the plan was written (advance).
    mode = "plan";
  } else {
    // Pi's overflow / manual compaction: layer dump + pi's standard
    // summarization of the ephemeral span.
    mode = "plain";
  }

  let llm: LlmResult | undefined;
  if (mode === "plain") {
    try {
      llm = await summarizePlain(
        {
          ...preparation,
          previousSummary: previousLlmTail(preparation.previousSummary),
        },
        ctx,
        event.signal,
      );
    } catch (err) {
      if (event.signal.aborted) throw err; // compaction cancelled: propagate
      // Local model unavailable or failed: keep the deterministic layer dump
      // rather than failing the whole compaction.
      if (ctx.hasUI)
        ctx.ui.notify(
          "pi-strata: pi summarization unavailable, keeping the layer dump only",
          "warning",
        );
    }
  }

  const strataSummary = buildStrataSummary(layers);
  const summary = llm
    ? `${strataSummary}${SEP}${normalizeText(llm.summary)}`
    : strataSummary;
  const details: StrataDetails = {
    strata: {
      mode,
      version: STRATA_VERSION,
      stepN,
      reportFiles: (layers.reports ?? []).map((r) => r.n),
      llmSummary: llm !== undefined,
    },
  };

  // `ctx.compact()` is asynchronous. Keep the request marker alive until this
  // hook consumes it: clearing it from `agent_settled` makes every requested
  // plan/step compaction look like an ordinary plain compaction.
  if (rt.pending) rt.pending = null;

  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage: llm?.usage,
      details,
    },
  };
}
