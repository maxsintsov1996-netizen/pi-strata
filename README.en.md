# pi-strata

An extension for [pi-coding-agent](https://github.com/badlogic/pi-mono) that
maximizes KV-cache / prompt-cache reuse for local LLMs (llama.cpp / Ollama)
via an **immutable, layer-grown context**.

Specification: [`SPEC.md`](./SPEC.md). (Russian: [`README.md`](./README.md).)

## Idea

The agent prompt is divided into layers whose prefix is **byte-stable**
across steps:

```text
[Layer 0] system prompt + static pi-strata instructions
  [Layer 1] /*STRATA::RESEARCH::v1*/ — research report (task, stack, constraints)
    [Layer 2] /*STRATA::PLAN::v1*/   — plan (TODO list, checkboxes)
      [Layer 3] /*STRATA::STEP-N::v1*/ — step reports (append-only)
        [current] ephemeral work (command output, logs) — discarded into a report
```

Layer data is **not stored in files**: the model writes each phase between
unique markers directly in its reply text, and the extension extracts the
blocks algorithmically (regex, the last block of each type wins). A new
RESEARCH or PLAN block starts a new task cycle: every STEP-N that stood
before it in the conversation (the previous task's reports) is dropped — a
new task does not inherit the old plan's step history. The post-compaction
summary = a marker line + the extracted blocks in a fixed
order (strictly joined with `\n\n`) — since the summary itself consists of
marked blocks, the next compaction extracts the layers from (summary + new
messages) with the same regex — the identical prefix is restored without any
files (round-trip).

Nothing inside the prefix is inserted or edited "on the fly": the allowed
mutations are only (a) a new STEP-N block (end of L3), (b) a new PLAN block
(updated checkbox — the latest version wins), (c) a new RESEARCH/PLAN — a
new task: all STEP-N blocks standing before it are dropped. The stable
prefix is
[system prompt + layer blocks]; on overflow compaction a standard pi LLM
summary follows the blocks (see "How it works", item 4) — after the blocks,
so the prefix is untouched.

## How it works

1. `session_start` — the session strata directory is created next to the
   session file: `<dir>/<session-name>.pi_strata/` — only for disposable
   snapshots in `tmp/` (the files **never** land in the project).
2. `before_agent_start` — the static pipeline instructions (Layer 0) are
   appended to the system prompt: the marker protocol, the order of actions,
   and the self-contained plan-item requirements.
3. The agent works according to the marker protocol:
   - after the research it writes a `/*STRATA::RESEARCH::v1*/` block (stack,
     architecture, inputs, constraints, acceptance criteria);
   - then a `/*STRATA::PLAN::v1*/` block (TODO list, format `- task`);
   - it calls `strata(action="advance")`; the first compaction happens at the
     end of the turn.
   - after each step: only a `/*STRATA::STEP-N::v1*/` block with a compact
     report → `strata(action="advance", step=N)` → compaction. PLAN stays as
     written; each completed step is recorded in its STEP-N report.
   - a new task (after a plan is complete): the cycle restarts — a fresh
     RESEARCH and a new PLAN; the previous task's STEP-N reports are dropped
     automatically, and the new cycle starts with a clean step history.
   Each plan item is self-contained: detailed enough to execute the step
   after compaction without re-reading the context.
   The `/*STRATA::…*/` anchors are not shown in the TUI transcript
   (display-only: pi's markdown transformer strips them before rendering —
   in the assistant's text and thinking, including streaming); the phase
   block bodies stay visible. The session, the model context, and the summary
   keep the raw markers — extraction is unaffected. Disable with
   `piStrata.hideAnchors: false` / `PI_STRATA_HIDE_ANCHORS=0` (re-resolved on
   `session_start`; the current value is visible in `/strata`:
   `anchors=hidden|shown`).
4. `session_before_compact` — compaction of a strata session: blocks are
   extracted with a regex from (previous summary + new messages), the last
   block of each type wins, and the summary = the deterministic assembly
   (the `custom summary` result). Before a completed step's compaction the
   ephemeral context is saved in `tmp/` (`step_N_raw.md`).
   Any other compaction (overflow, manual) keeps the strata sections and runs
   pi's standard summarization on top of them: summary = layer blocks + the
   LLM summary of the ephemeral span (the same prompts and merge semantics as
   pi without the extension). The LLM never receives the blocks themselves
   (the merge input is only its own previous tail, and the prompt tells it not
   to restate the STRATA blocks it sees in the raw conversation), so the
   stable prefix never passes through the model. If no model/auth is
   available or the LLM call fails — fallback to the plain layer dump; the
   in-flight work within `compaction.keepRecentTokens` still stays in the tail.
   Conflicts with other extensions: if another extension also handles
   `session_before_compact`, pi uses the result of the last-loaded handler
   (there is no merge). Strata marks its own result (`details.strata`) and
   verifies after compaction that it was the one saved: if a foreign handler
   replaced it, a warning is shown with the cause and the advice to keep a
   single compaction handler (or load pi-strata last).
5. After the next step's compaction — auto-continuation (disabled with
   `PI_STRATA_AUTO_CONTINUE=0`).
6. A session was deleted (the `.jsonl` is gone — via pi's session picker or
   manually): the orphaned `*.pi_strata` directory is cleaned up
   automatically at the start of the next session (pi has no "session
   deleted" event, so the cleanup is lazy, in `session_start`).
7. The strata mode is **per-session state, not a setting**: it is **off by
   default** and is enabled for the current session with `/strata-on`. Nothing
   is written to files: a new session (re)start (or `/reload`) begins with the
   mode off again; there is deliberately no in-session off command — off is
   the session default. While enabled, the layer-0 instructions are appended
   to the system prompt and compaction is intercepted (`session_before_compact`);
   while disabled, the instructions are not added, compaction falls back to
   pi's default, pending phase requests are dropped, and the plan widget is
   hidden. While the plan dashboard is not visible (no strata blocks in the
   session yet), the `strata: on|off` mode widget is shown at the bottom of
   the screen (pi-lens style); once the dashboard is up, the mode widget is
   hidden — the dashboard already shows the strata state. A resumed/forked strata session starts
   off, but at session start a notice is shown: layers were found in the
   conversation, and `/strata-on` restores the pipeline. Enabling is safe:
   the layers live in the conversation and are re-extracted from the branch.

## Installation

```bash
pi install /path/to/pi-strata
# or locally:
cp -r pi-strata ~/.pi/agent/extensions/pi-strata
```

Dependencies: only `@earendil-works/pi-coding-agent` (peer). TypeScript is
compiled by jiti in the pi runtime — no build step.

## Commands and tools

- the `strata` tool (actions: `advance` / `status`); `advance` validates the
  blocks against the branch: for the plan — a PLAN block must exist, for a
  step — a STEP-N block; PLAN remains immutable;
- `/strata` — layer status; `/strata compact` — forced compaction;
  `/strata reset` — clear the session directory (`tmp/`);
- `/strata-on` — enable the strata mode for the current session (off by
  default; per-session state, nothing is written to files; see "How it
  works", item 7).

## Configuration

Priority per parameter: **env > config file > default**.
Invalid values at any level are ignored (fall-through to the next level).

### File: `piStrata` in pi's settings.json

| File | Scope |
| --- | --- |
| `~/.pi/agent/settings.json` | global |
| `.pi/settings.json` | project (fields override the global ones) |

```json
{
  "piStrata": {
    "autoContinue": true,
    "hideAnchors": true
  }
}
```

The on/off mode is **not a setting**: it is per-session state (off by
default; `/strata-on` enables it for the session — see "How it works",
item 7). A legacy `piStrata.enabled` field in settings.json and
`PI_STRATA_ENABLED` are no longer read.

### Environment variables (override the config)

| Variable | Config field | Default | Description |
| --- | --- | --- | --- |
| `PI_STRATA_AUTO_CONTINUE` | `autoContinue` | on | auto-continue the next step after compaction (`0` — off) |
| `PI_STRATA_HIDE_ANCHORS` | `hideAnchors` | on | hide STRATA anchors in the TUI transcript (display only; `0` — show them) |
| `PI_ROOT` | — | global install | path to pi-coding-agent (self-test only) |

The effective settings are visible in `strata(action="status")` / `/strata`
(the `settings: ...` line).

## Structure

```text
index.ts      — event registration, strata tool, /strata and /strata-on commands
compaction.ts — session_before_compact: plan/step/plain modes
                (plain = strata sections + pi's standard LLM summary)
strata.ts     — pure logic: markers, extraction, latest-wins + cycle
                boundary (a new RESEARCH/PLAN resets the reports), summary
                (byte-stable), round-trip, plan parsing, snapshots
check.cjs     — self-test (57 tests)
```

## Verification

```bash
npm test              # node check.cjs (jiti + aliases as in the pi runtime)
npm run typecheck     # tsc --noEmit
```
