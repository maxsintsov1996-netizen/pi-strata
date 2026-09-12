// pi-strata — core strata logic.
//
// Phase data lives in the conversation, not in files: the model writes each
// phase between unique markers, and the extension extracts the blocks
// algorithmically (regex, SPEC §2):
//
//   /*STRATA::RESEARCH::v1*/ … /*STRATA::END::RESEARCH::v1*/
//   /*STRATA::PLAN::v1*/     … /*STRATA::END::PLAN::v1*/
//   /*STRATA::STEP-N::v1*/   … /*STRATA::END::STEP-N::v1*/
//
// Extraction semantics — "latest wins": blocks are processed in scan order
// (previous compaction summary first, then the new conversation span), and a
// later occurrence of the same phase key replaces the earlier one. A RESEARCH
// or PLAN block additionally marks the start of a NEW task cycle: every
// STEP-N report that appeared before it in scan order belongs to the
// previous cycle and is dropped (a new task must not inherit the old plan's
// step reports). Reports written after the boundary are kept. The
// compaction summary is the extracted blocks re-emitted in fixed order, so
// the next extraction over (summary + new span) rebuilds the prefix
// byte-stably without any on-disk layer state.
//
// Byte-stability contract (SPEC §4):
//  - extractLayers() and buildStrataSummary() are pure functions;
//  - every block body is normalized before storage or emission;
//  - the summary layout is fixed: marker line, then RESEARCH, PLAN,
//    STEP-1..N (ascending) — joined with exactly SEP ("\n\n");
//  - allowed prefix mutations: a replaced phase block (corrected research,
//    plan checkbox toggle), an appended step report.
//
// The session strata directory keeps raw context snapshots only (tmp/),
// written by the extension at compaction time.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const STRATA_VERSION = "v1";
export const STRATA_MARKER = `## PI-STRATA CONTEXT (${STRATA_VERSION})`;

/** Strict separator between layers: exactly two newline characters. */
export const SEP = "\n\n";

/**
 * Normalize phase text: CRLF/CR -> LF, strip trailing whitespace on every
 * line, trim the whole text. Idempotent — applying twice changes nothing.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Marker blocks
// ---------------------------------------------------------------------------

/** One well-formed phase block (body already normalized). */
export interface StrataBlock {
  /** Phase key: "RESEARCH", "PLAN", or "STEP-N". */
  key: string;
  /** Step number for STEP-N blocks. */
  stepN?: number;
  text: string;
}

/** Wrap a phase body in its marker pair (the exact tokens the model emits). */
export function strataBlock(key: string, body: string): string {
  return `/*STRATA::${key}::v1*/\n${normalizeText(body)}\n/*STRATA::END::${key}::v1*/`;
}

/**
 * All well-formed STRATA:: blocks in `text`, in order of appearance.
 * Unclosed pairs never match; a pair whose body re-opens the same phase
 * (malformed/nested) is skipped, and empty bodies are dropped.
 */
export function extractStrataBlocks(text: string): StrataBlock[] {
  const BLOCK_RE =
    /\/\*STRATA::(RESEARCH|PLAN|STEP-(\d+))::v1\*\/([\s\S]*?)\/\*STRATA::END::\1::v1\*\//g;
  const blocks: StrataBlock[] = [];
  for (let m = BLOCK_RE.exec(text); m !== null; m = BLOCK_RE.exec(text)) {
    const key = m[1];
    const body = normalizeText(m[3]);
    if (body.length === 0) continue;
    if (body.includes(`/*STRATA::${key}::v1*/`)) continue;
    blocks.push({
      key,
      stepN: m[2] === undefined ? undefined : Number(m[2]),
      text: body,
    });
  }
  return blocks;
}

/**
 * Layered view of the conversation: the extracted phase blocks folded with
 * "latest wins" (a later block of the same phase key replaces the earlier
 * one). A RESEARCH or PLAN block also starts a new task cycle and drops all
 * STEP-N reports that appeared before it. `reports` is sorted by step number.
 */
export interface StrataLayers {
  research?: string;
  plan?: string;
  reports?: { n: number; text: string }[];
}

/** Fold blocks into layers; undefined when there are no blocks at all. */
export function blocksToLayers(
  blocks: StrataBlock[],
): StrataLayers | undefined {
  if (blocks.length === 0) return undefined;
  const layers: StrataLayers = {};
  let reports: { n: number; text: string }[] = [];
  for (const b of blocks) {
    if (b.key === "RESEARCH" || b.key === "PLAN") {
      // New task cycle: step reports that appeared before this RESEARCH/PLAN
      // block belong to the previous cycle and are dropped.
      if (b.key === "RESEARCH") layers.research = b.text;
      else layers.plan = b.text;
      reports = [];
    } else if (b.stepN !== undefined) {
      const i = reports.findIndex((r) => r.n === b.stepN);
      if (i >= 0) reports[i].text = b.text;
      else reports.push({ n: b.stepN, text: b.text });
    }
  }
  reports.sort((a, b) => a.n - b.n);
  layers.reports = reports;
  return layers;
}

/** extractStrataBlocks + blocksToLayers in one step (compaction hot path). */
export function extractLayers(text: string): StrataLayers | undefined {
  return blocksToLayers(extractStrataBlocks(text));
}

/**
 * Build the strata summary injected as the compaction summary: the marker
 * line followed by the phase blocks in fixed order (RESEARCH, PLAN,
 * STEP-1..N ascending), joined with exactly SEP. Pure and idempotent:
 * identical layers always produce identical bytes.
 */
export function buildStrataSummary(layers: StrataLayers): string {
  const out: string[] = [STRATA_MARKER];
  if (layers.research) out.push(strataBlock("RESEARCH", layers.research));
  if (layers.plan) out.push(strataBlock("PLAN", layers.plan));
  for (const r of layers.reports ?? [])
    out.push(strataBlock(`STEP-${r.n}`, r.text));
  return out.join(SEP);
}

// ---------------------------------------------------------------------------
// Display: marker anchors hidden in the TUI transcript
// ---------------------------------------------------------------------------

/**
 * Strip STRATA marker anchors from Markdown for display: a marker that owns
 * its line drops the whole line (paragraph spacing is preserved), and an
 * inline marker drops the token itself. Block bodies are kept — the phase
 * content stays readable in the transcript. Display-only: fed to pi's
 * markdown transformer, which renders the result in the TUI while the
 * session and the model context keep the raw markers. Pure, synchronous,
 * idempotent.
 */
export function stripStrataMarkersForDisplay(md: string): string {
  return md
    .replace(
      /(^|\n)[ \t]*\/\*STRATA::(?:END::)?(?:RESEARCH|PLAN|STEP-\d+)::v1\*\/[ \t]*\n/g,
      "$1",
    )
    .replace(/\/\*STRATA::(?:END::)?(?:RESEARCH|PLAN|STEP-\d+)::v1\*\//g, "");
}

// ---------------------------------------------------------------------------
// Plan (TODO) parsing — markdown checkboxes
// ---------------------------------------------------------------------------

// Checkbox syntax is accepted for compatibility with earlier sessions; new
// plans use plain markdown bullets (`- action`).
const PLAN_ITEM_RE = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/;

export interface PlanItem {
  text: string;
  done: boolean;
}

/** Extract checkbox items from plan markdown. Non-item lines are ignored. */
export function parsePlan(md: string): PlanItem[] {
  const items: PlanItem[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(PLAN_ITEM_RE);
    if (m) items.push({ text: m[2].trim(), done: m[1]?.toLowerCase() === "x" });
  }
  return items;
}

/** 0-based index of the first unchecked item, or -1 when all done / no plan. */
export function firstUnchecked(md: string): number {
  return parsePlan(md).findIndex((t) => !t.done);
}

export function itemText(md: string, index: number): string | undefined {
  return parsePlan(md)[index]?.text;
}

export function planCounts(md: string): { done: number; total: number } {
  const items = parsePlan(md);
  return { done: items.filter((t) => t.done).length, total: items.length };
}

/** Progress is append-only: a STEP-N report is the completion record for plan item N. */
export function reportPlanCounts(
  md: string,
  reports: readonly { n: number }[],
): { done: number; total: number } {
  const total = parsePlan(md).length;
  const completed = new Set<number>();
  for (const report of reports) {
    if (report.n >= 1 && report.n <= total) completed.add(report.n);
  }
  return { done: completed.size, total };
}

/** 0-based first plan item without its append-only STEP-N report, or -1. */
export function firstUnreportedPlanStep(
  md: string,
  reports: readonly { n: number }[],
): number {
  const completed = new Set(reports.map((report) => report.n));
  return parsePlan(md).findIndex((_item, index) => !completed.has(index + 1));
}

// ---------------------------------------------------------------------------
// Widgets (pi-lens style): themeable single-line segments
// ---------------------------------------------------------------------------

/** Theme colors the widgets use (a subset of pi's ThemeColor). */
export type WidgetColor = "accent" | "dim" | "success";

/** One colored run of a widget line. */
export interface WidgetSegment {
  text: string;
  color?: WidgetColor;
}

/**
 * Short label for a plan item on the one-line dashboard: the part before
 * the first colon (plan items are usually written as "Step N (target):
 * details"), falling back to the full text, capped at 56 chars.
 */
export function planItemLabel(md: string, index: number): string {
  const t = (itemText(md, index) ?? "").trim();
  const cut = t.indexOf(":");
  const label = cut > 0 ? t.slice(0, cut).trim() : t;
  return label.length > 56 ? `${label.slice(0, 55)}…` : label;
}

/**
 * The plan dashboard as a single line of segments (pi-lens style: leading
 * space, accent brand, dim secondary info, colored status):
 *
 *   " strata  2/5 ✓✓▶··  next: #3 <label>"   (✓ success, ▶ accent, · dim)
 *   " strata  research done — plan pending"  (no plan yet)
 *   " strata  pre-plan"                      (no research yet)
 */
export function planDashboardSegments(
  plan: string | undefined,
  reports: readonly { n: number }[],
  hasResearch: boolean,
): WidgetSegment[] {
  const brand: WidgetSegment = { text: " strata", color: "accent" };
  if (!plan) {
    return [
      brand,
      {
        text: `  ${hasResearch ? "research done — plan pending" : "pre-plan"}`,
        color: "dim",
      },
    ];
  }
  const total = parsePlan(plan).length;
  const completed = new Set<number>();
  for (const report of reports) {
    if (report.n >= 1 && report.n <= total) completed.add(report.n);
  }
  const done = completed.size;
  const nextIdx = firstUnreportedPlanStep(plan, reports);
  const segments: WidgetSegment[] = [
    brand,
    { text: `  ${done}/${total} `, color: "dim" },
  ];
  for (let i = 0; i < total; i++) {
    if (completed.has(i + 1)) segments.push({ text: "✓", color: "success" });
    else if (i === nextIdx) segments.push({ text: "▶", color: "accent" });
    else segments.push({ text: "·", color: "dim" });
  }
  if (nextIdx >= 0) {
    segments.push({ text: `  next: #${nextIdx + 1} `, color: "dim" });
    segments.push({ text: planItemLabel(plan, nextIdx) });
  } else {
    segments.push({ text: "  all done", color: "success" });
  }
  return segments;
}

/** The mode indicator line (below the editor), pi-lens style. */
export function modeSegments(enabled: boolean): WidgetSegment[] {
  return enabled
    ? [
        { text: " strata", color: "accent" },
        { text: "  on", color: "success" },
      ]
    : [
        { text: " strata", color: "accent" },
        { text: "  off", color: "dim" },
      ];
}

// ---------------------------------------------------------------------------
// TUI text fitting: widget lines must not wrap on narrow terminals
// ---------------------------------------------------------------------------

const SGR_RE = /\x1b\[[0-9;]*m/g;

/** Terminal cell width of a string (ANSI SGR escapes excluded). */
export function visibleWidth(s: string): number {
  return s.replace(SGR_RE, "").length;
}

/**
 * Truncate a (possibly colored) line to the terminal width, replacing the
 * tail with an ellipsis. ANSI escapes are kept intact and never counted.
 */
export function fitLine(s: string, maxWidth: number): string {
  const w = Math.max(1, Math.floor(maxWidth));
  if (visibleWidth(s) <= w) return s;
  const limit = w - 1; // room for the ellipsis
  let visible = 0;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (visible >= limit) break;
    out += ch;
    visible += 1;
  }
  return `${out}…`;
}

// ---------------------------------------------------------------------------
// Session strata directory: raw context snapshots (tmp/) only
// ---------------------------------------------------------------------------

export interface StrataPaths {
  dir: string;
  /** Raw ephemeral context snapshots (disposable, outside the prefix). */
  tmp: string;
}

export function strataPaths(dir: string): StrataPaths {
  return { dir, tmp: join(dir, "tmp") };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Write a raw ephemeral context snapshot (tmp layer, disposable). */
export function writeSnapshot(path: string, title: string, body: string): void {
  ensureDir(dirname(path));
  const text = normalizeText(body);
  writeFileSync(
    path,
    `# Raw context snapshot — ${title}\n${SEP}${text}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

const STRATA_DIR_SUFFIX = ".pi_strata";

/**
 * Remove orphaned strata directories: <name>.pi_strata whose sibling
 * <name>.jsonl session file no longer exists (the session was deleted).
 * pi fires no "session deleted" event, so orphans are collected lazily on
 * session start. Only entries inside `sessionsDir` are touched; anything
 * with a live session file is kept. Returns the number of dirs removed.
 */
export function cleanupOrphanedStrataDirs(sessionsDir: string): number {
  let removed = 0;
  for (const entry of readdirSyncSafe(sessionsDir)) {
    if (!entry.endsWith(STRATA_DIR_SUFFIX)) continue;
    const sessionFile = entry.slice(0, -STRATA_DIR_SUFFIX.length) + ".jsonl";
    if (existsSync(join(sessionsDir, sessionFile))) continue;
    rmSync(join(sessionsDir, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
