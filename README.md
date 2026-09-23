<p align="center"><img src="./img/pi-strata.png" alt="pi-strata" width="180"></p>

# pi-strata

**Advanced context compaction** for
[pi-coding-agent](https://github.com/badlogic/pi-mono): a phased pipeline
(research → plan → steps) where compaction happens after every phase, while
the task's important state — research, plan, step reports — passes through it
unscathed.

A byproduct of the mechanism: an **immutable, layer-grown context** with a
byte-stable prefix — local LLMs (llama.cpp / Ollama) reuse the KV cache
(prompt-caching) across phases.

Specification: [`SPEC.md`](./SPEC.md). (Russian: [`README.ru.md`](./README.ru.md).)

## Idea

The agent's context is compacted **phase by phase**. The prompt is divided
into layers whose prefix is **byte-stable** across steps:

```text
[Layer 0] system prompt + static pi-strata instructions
  [Layer 1] /*STRATA::RESEARCH::v1*/ — research report
    [Layer 2] /*STRATA::PLAN::v1*/   — plan (TODO list)
      [Layer 3] /*STRATA::STEP-N::v1*/ — step reports (append-only)
        [current] ephemeral work — discarded into reports
```

Layer data is **not stored in files**: the model writes each phase between
unique markers in its reply, and the extension extracts the blocks (regex,
the last block of each type wins). The post-compaction summary is a
deterministic assembly of the extracted blocks (round-trip): compaction
rewrites the ephemeral context, the important state passes through as-is,
and the identical prefix is restored without any files.

A new RESEARCH or PLAN starts a new task cycle — the previous task's STEP-N
reports are dropped, and the new task starts with a clean history.

## How it works

1. The mode is **per-session state, not a setting**: off by default, enabled
   for the current session with `/strata-on` (nothing is written to files;
   there is no off command — off is the default).
2. On enable, the Layer 0 instructions are added to the system prompt — with
   a KV-cache guard: in a session that already carries context they are
   first delivered as a standing message at the end of the conversation and
   move into the system prompt only after the next compaction (a mid-session
   prompt change would make the model re-read the whole context).
3. The pipeline: RESEARCH → PLAN → `strata(action="advance")` → compaction at
   the end of the turn; after each step — a STEP-N block with a report →
   `strata(action="advance", step=N)` → compaction. The phase's ephemeral
   context is compacted away, the report is recorded in the layers; the plan
   stays immutable, and every plan item is self-contained for execution
   after compaction.
4. Compaction modes: plan/step — a deterministic layer dump (the raw context
   of a completed step is saved to `<session>.pi_strata/tmp/` for auditing,
   outside the project); any other compaction (overflow / manual) — layer
   blocks + pi's standard LLM summarization of the ephemeral tail on top of
   them (the model never receives the blocks themselves, so the prefix never
   passes through the model; when no model is available — fallback to the
   layer dump).
5. After a step compaction — auto-continuation of the next step (can be
   disabled). Orphaned directories of deleted sessions are cleaned up at the
   next session's `session_start`.
6. TUI: a dashboard above the editor (`strata  2/5 ✓✓▶··  next: #3 …`) and a
   mode indicator; the `/*STRATA::…*/` anchors are hidden in the transcript
   (display-only, configurable) while block bodies stay visible. A resumed
   strata session starts off with a notice that `/strata-on` restores the
   pipeline (the layers live in the conversation).

## What you get

- the task's important state survives any number of compactions — the
  STEP-N reports are the information store;
- a byte-stable [system prompt + layers] prefix → KV-cache reuse with local
  LLMs across all phases;
- deterministic, reproducible summaries without layer files;
- raw phase snapshots in `tmp/` for debugging, with automatic cleanup.

## Installation

```bash
pi install git:github.com/maxsintsov1996-netizen/pi-strata@v0.1.0
# or from a local checkout:
pi install /path/to/pi-strata
```

Dependency: only `@earendil-works/pi-coding-agent` (peer). TypeScript is
compiled by jiti in the pi runtime — no build step.

## Commands and tools

- the `strata` tool: `advance` (plan / `step=N`, with branch validation) and
  `status`;
- `/strata` — layer status; `/strata compact` — forced compaction;
  `/strata reset` — clear `tmp/`;
- `/strata-on` — enable the mode for the current session.

## Configuration

Priority: **env > settings.json > default**; invalid values are ignored.
Files: `~/.pi/agent/settings.json` (global) and `.pi/settings.json` (project,
overrides the global one).

| Variable | settings.json | Default | Description |
| --- | --- | --- | --- |
| `PI_STRATA_AUTO_CONTINUE` | `piStrata.autoContinue` | on | auto-continue the step after compaction (`0` — off) |
| `PI_STRATA_HIDE_ANCHORS` | `piStrata.hideAnchors` | on | hide STRATA anchors in the TUI transcript (`0` — show) |
| `PI_ROOT` | — | `./node_modules` | path to pi-coding-agent (self-test only) |

The effective settings are visible in `/strata` (the `settings: …` line).

## Structure and verification

```text
index.ts      — events, strata tool, /strata and /strata-on commands
compaction.ts — session_before_compact: plan/step/plain modes
strata.ts     — pure logic: markers, extraction, summary (byte-stable), plan
check.cjs     — self-test (64 tests)
```

```bash
npm test              # node check.cjs
npm run typecheck     # tsc --noEmit
```
