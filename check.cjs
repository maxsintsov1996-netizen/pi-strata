/**
 * pi-strata self-test.
 *
 * No test framework, no dependencies: loads the TS sources through jiti
 * (shipped with pi-coding-agent) with the same package aliases pi uses at
 * runtime, then exercises:
 *   1. pure strata logic (normalization, marker extraction, latest-wins
 *      folding, summary byte-stability, round-trips, plan parsing),
 *   2. extension wiring (factory registers events/tool/command),
 *   3. the strata tool end-to-end (advance validation against the branch),
 *   4. the session_before_compact handler (plan/step/plain modes).
 *
 * NOTE: this file is CJS on purpose — pi's extension loader runs jiti in a
 * CJS context, and jiti's specifier fallback for pi-ai subpaths only works
 * there (an ESM test harness fails to resolve @earendil-works/pi-ai/utils/*).
 *
 * Run: node check.cjs   (or: npm test)
 * Set PI_ROOT to override the pi-coding-agent install location.
 */

"use strict";

const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const here = __dirname;
const PI_ROOT =
  process.env.PI_ROOT ??
  "/home/max/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";

const piRequire = createRequire(join(PI_ROOT, "package.json"));
const { createJiti } = piRequire("jiti");
const PI_AI_DIST = join(PI_ROOT, "node_modules/@earendil-works/pi-ai/dist");

// Mirrors pi's own extension loader: jiti rooted at the loader module with the
// same alias table (dist/core/extensions/loader.js getAliases).
const jiti = createJiti(join(PI_ROOT, "dist/core/extensions/loader.js"), {
  alias: {
    "@earendil-works/pi-coding-agent": join(PI_ROOT, "dist/index.js"),
    "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
    "@earendil-works/pi-ai": join(PI_AI_DIST, "compat.js"),
    "@earendil-works/pi-ai/compat": join(PI_AI_DIST, "compat.js"),
    "@earendil-works/pi-ai/oauth": join(PI_AI_DIST, "oauth.js"),
    "@earendil-works/pi-ai/providers/all": join(PI_AI_DIST, "providers/all.js"),
    typebox: piRequire.resolve("typebox"),
    "typebox/compile": piRequire.resolve("typebox/compile"),
    "typebox/value": piRequire.resolve("typebox/value"),
    "@sinclair/typebox": piRequire.resolve("typebox"),
    "@sinclair/typebox/compile": piRequire.resolve("typebox/compile"),
    "@sinclair/typebox/value": piRequire.resolve("typebox/value"),
  },
  tryNative: false,
});

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

// Marker block fixtures (exact tokens the model emits).
const R =
  "/*STRATA::RESEARCH::v1*/\nstack: node\nconstraints: local LLM\n/*STRATA::END::RESEARCH::v1*/";
const PLAN1 =
  "/*STRATA::PLAN::v1*/\n- [ ] write parser\n- [ ] add tests\n/*STRATA::END::PLAN::v1*/";
const PLAN1_DONE =
  "/*STRATA::PLAN::v1*/\n- [x] write parser\n- [ ] add tests\n/*STRATA::END::PLAN::v1*/";

const main = async () => {
  console.log("strata.ts — pure logic");

  // NOTE: use the async import form — jiti's sync loader path lacks the
  // specifier fallback for aliased pi-ai subpaths and fails to load the
  // pi-coding-agent chain.
  const strata = await jiti.import(join(here, "strata.ts"));

  await test("normalizeText: CRLF, trailing ws, idempotent", () => {
    const raw = "line one  \r\nline two\r\n\r\n  padded  \n";
    const once = strata.normalizeText(raw);
    assert.equal(once, "line one\nline two\n\n  padded");
    assert.equal(strata.normalizeText(once), once);
  });

  await test("extractStrataBlocks: well-formed blocks with bodies and step numbers", () => {
    const text = `intro\n${R}\nmid\n${PLAN1}\n/*STRATA::STEP-2::v1*/\nstep two report\n/*STRATA::END::STEP-2::v1*/\nend`;
    const blocks = strata.extractStrataBlocks(text);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].key, "RESEARCH");
    assert.equal(blocks[0].text, "stack: node\nconstraints: local LLM");
    assert.equal(blocks[1].key, "PLAN");
    assert.equal(blocks[2].key, "STEP-2");
    assert.equal(blocks[2].stepN, 2);
    assert.equal(blocks[2].text, "step two report");
  });

  await test("blocksToLayers: latest wins per phase key, steps sorted", () => {
    const layers = strata.blocksToLayers([
      { key: "PLAN", text: "- [ ] a" },
      { key: "RESEARCH", text: "r1" },
      { key: "STEP-1", stepN: 1, text: "old" },
      { key: "STEP-2", stepN: 2, text: "did b" },
      { key: "PLAN", text: "- [x] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "new" },
    ]);
    assert.equal(layers.plan, "- [x] a\n- [ ] b");
    assert.equal(layers.research, "r1");
    // STEP-2 stood before the new PLAN (previous cycle) -> dropped; only the
    // report written after the boundary survives
    assert.deepEqual(layers.reports, [{ n: 1, text: "new" }]);
    assert.equal(strata.blocksToLayers([]), undefined);
  });

  await test("blocksToLayers: new RESEARCH+PLAN drops the previous cycle's reports", () => {
    const layers = strata.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [ ] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "did a" },
      { key: "STEP-2", stepN: 2, text: "did b" },
      { key: "RESEARCH", text: "r2" },
      { key: "PLAN", text: "- [ ] c\n- [ ] d\n- [ ] e" },
    ]);
    assert.equal(layers.research, "r2");
    assert.equal(layers.plan, "- [ ] c\n- [ ] d\n- [ ] e");
    assert.deepEqual(layers.reports, []);
  });

  await test("blocksToLayers: a new PLAN alone also resets the reports", () => {
    const layers = strata.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [ ] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "did a" },
      { key: "PLAN", text: "- [ ] x\n- [ ] y" },
    ]);
    assert.equal(layers.research, "r1");
    assert.equal(layers.plan, "- [ ] x\n- [ ] y");
    assert.deepEqual(layers.reports, []);
  });

  await test("blocksToLayers: reports after the new cycle boundary are kept", () => {
    const layers = strata.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [ ] a" },
      { key: "STEP-1", stepN: 1, text: "old a" },
      { key: "RESEARCH", text: "r2" },
      { key: "PLAN", text: "- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "new b" },
    ]);
    assert.equal(layers.research, "r2");
    assert.equal(layers.plan, "- [ ] b");
    assert.deepEqual(layers.reports, [{ n: 1, text: "new b" }]);
  });

  await test("blocksToLayers: no new RESEARCH/PLAN -> reports untouched", () => {
    const layers = strata.blocksToLayers([
      { key: "RESEARCH", text: "r1" },
      { key: "PLAN", text: "- [ ] a\n- [ ] b" },
      { key: "STEP-1", stepN: 1, text: "did a" },
      { key: "STEP-2", stepN: 2, text: "did b" },
    ]);
    assert.deepEqual(layers.reports, [
      { n: 1, text: "did a" },
      { n: 2, text: "did b" },
    ]);
  });

  await test("extractStrataBlocks: malformed pairs skipped, empty bodies dropped", () => {
    const text = [
      "/*STRATA::PLAN::v1*/ unclosed plan text",
      "/*STRATA::PLAN::v1*/ bad\n/*STRATA::PLAN::v1*/ re-open\n/*STRATA::END::PLAN::v1*/",
      "/*STRATA::RESEARCH::v1*/\n   \n/*STRATA::END::RESEARCH::v1*/",
      "/*STRATA::RESEARCH::v1*/\nvalid research\n/*STRATA::END::RESEARCH::v1*/",
    ].join("\n");
    const blocks = strata.extractStrataBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].key, "RESEARCH");
    assert.equal(blocks[0].text, "valid research");
  });

  await test("buildStrataSummary: marker line, blocks in fixed order, strict seams", () => {
    const layers = {
      research: "r",
      plan: "- [ ] a",
      reports: [{ n: 1, text: "rep" }],
    };
    const s = strata.buildStrataSummary(layers);
    assert.ok(
      s.startsWith(
        "## PI-STRATA CONTEXT (v1)\n\n/*STRATA::RESEARCH::v1*/\nr\n/*STRATA::END::RESEARCH::v1*/",
      ),
    );
    assert.ok(
      s.includes("/*STRATA::PLAN::v1*/\n- [ ] a\n/*STRATA::END::PLAN::v1*/"),
    );
    assert.ok(
      s.includes("/*STRATA::STEP-1::v1*/\nrep\n/*STRATA::END::STEP-1::v1*/"),
    );
    // only \n\n between blocks — no single-newline seams
    assert.ok(!s.includes("*/\n/*"));
    assert.equal(strata.buildStrataSummary({ ...layers }), s);
  });

  await test("byte-stability across steps: research bytes survive plan/report changes", () => {
    const research = "Stack: node, ts\nConstraints: local LLM";
    const a = strata.buildStrataSummary({
      research,
      plan: "- [ ] a\n- [ ] b",
      reports: [{ n: 1, text: "did a" }],
    });
    const b = strata.buildStrataSummary({
      research,
      plan: "- [x] a\n- [ ] b",
      reports: [
        { n: 1, text: "did a" },
        { n: 2, text: "did b" },
      ],
    });
    // marker + research block identical in both
    assert.ok(b.startsWith(a.slice(0, a.indexOf("/*STRATA::PLAN"))));
    assert.ok(b.includes("/*STRATA::STEP-2::v1*/\ndid b"));
  });

  await test("summary round-trip: build -> extractLayers -> build is identical", () => {
    const layers = {
      research: "R line 1\nR line 2",
      plan: "- [x] a\n- [ ] b",
      reports: [
        { n: 1, text: "rep one" },
        { n: 3, text: "rep three" },
      ],
    };
    const s = strata.buildStrataSummary(layers);
    const parsed = strata.extractLayers(s);
    assert.ok(parsed);
    assert.equal(parsed.research, layers.research);
    assert.equal(parsed.plan, layers.plan);
    assert.deepEqual(
      parsed.reports.map((r) => [r.n, r.text]),
      [
        [1, "rep one"],
        [3, "rep three"],
      ],
    );
    assert.equal(strata.buildStrataSummary(parsed), s);
  });

  await test("extractLayers rejects non-strata text", () => {
    assert.equal(strata.extractLayers("## Goal\nrandom summary"), undefined);
  });

  await test("stripStrataMarkersForDisplay: anchors hidden, bodies and prose kept", () => {
    const md = `Привет! Иду к плану.\n\n${R}\n\nТеперь план:\n\n${PLAN1}\n\ninline /*STRATA::STEP-1::v1*/ body /*STRATA::END::STEP-1::v1*/ after\n\nФинал.`;
    const out = strata.stripStrataMarkersForDisplay(md);
    assert.ok(!out.includes("STRATA::"), "no anchors left");
    for (const kept of [
      "Привет! Иду к плану.",
      "stack: node",
      "constraints: local LLM",
      "- [ ] write parser",
      "- [ ] add tests",
      "body",
      "Финал.",
    ]) {
      assert.ok(out.includes(kept), `kept: ${kept}`);
    }
    // idempotent; clean text passes through unchanged
    assert.equal(strata.stripStrataMarkersForDisplay(out), out);
    assert.equal(
      strata.stripStrataMarkersForDisplay("plain\n\n- [ ] item"),
      "plain\n\n- [ ] item",
    );
    // a partially streamed marker token is not a full token yet — untouched
    assert.ok(
      strata
        .stripStrataMarkersForDisplay("x /*STRATA::RESEARC")
        .includes("/*STRATA::RESEARC"),
    );
  });

  await test("plan: parse/firstUnchecked/itemText/planCounts", () => {
    const raw =
      "  * [ ] first\n- [X] second\n+ [x] third\nprose line\n- [ ]   spaced  ";
    const items = strata.parsePlan(raw);
    assert.deepEqual(
      items.map((i) => [i.done, i.text]),
      [
        [false, "first"],
        [true, "second"],
        [true, "third"],
        [false, "spaced"],
      ],
    );
    assert.equal(strata.firstUnchecked(raw), 0);
    assert.equal(strata.itemText(raw, 1), "second");
    assert.equal(strata.planCounts(raw).done, 2);
    assert.deepEqual(
      strata.reportPlanCounts(raw, [{ n: 1 }, { n: 3 }, { n: 99 }]),
      { done: 2, total: 4 },
    );
    assert.equal(strata.firstUnreportedPlanStep(raw, [{ n: 1 }, { n: 3 }]), 1);
  });

  const joinSegments = (segments) => segments.map((s) => s.text).join("");

  await test("planItemLabel: colon cut, fallback to full text, 56 cap", () => {
    const md =
      "- [ ] Step 1 (Makefile): add build targets\n- [ ] just a long item without any colon in it at all here";
    assert.equal(strata.planItemLabel(md, 0), "Step 1 (Makefile)");
    assert.equal(
      strata.planItemLabel(md, 1),
      "just a long item without any colon in it at all here",
    );
    const long = "x".repeat(70);
    assert.equal(
      strata.planItemLabel(`- [ ] ${long}`, 0),
      `${"x".repeat(55)}…`,
    );
    // a colon in the first position is not a boundary
    assert.equal(strata.planItemLabel("- [ ] :nope", 0), ":nope");
  });

  await test("planDashboardSegments: pi-lens style line (brand, counter, bar, next)", () => {
    const plan = "- [x] a\n- [x] b\n- [ ] c\n- [ ] d";
    const segs = strata.planDashboardSegments(plan, [{ n: 1 }, { n: 2 }], true);
    assert.equal(joinSegments(segs), " strata  2/4 ✓✓▶·  next: #3 c");
    assert.equal(segs[0].color, "accent"); // brand
    assert.equal(segs[1].color, "dim"); // counter
    // bar: done=success, next=accent, todo=dim (after brand and counter)
    const bar = segs.slice(2, 6);
    assert.deepEqual(
      bar.map((s) => [s.text, s.color]),
      [
        ["✓", "success"],
        ["✓", "success"],
        ["▶", "accent"],
        ["·", "dim"],
      ],
    );
    // all done
    const done = strata.planDashboardSegments(
      plan,
      [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
      true,
    );
    assert.equal(joinSegments(done), " strata  4/4 ✓✓✓✓  all done");
    // no plan yet
    assert.equal(
      joinSegments(strata.planDashboardSegments(undefined, [], true)),
      " strata  research done — plan pending",
    );
    assert.equal(
      joinSegments(strata.planDashboardSegments(undefined, [], false)),
      " strata  pre-plan",
    );
  });

  await test("modeSegments: on=success, off=dim", () => {
    assert.deepEqual(strata.modeSegments(true), [
      { text: " strata", color: "accent" },
      { text: "  on", color: "success" },
    ]);
    assert.deepEqual(strata.modeSegments(false), [
      { text: " strata", color: "accent" },
      { text: "  off", color: "dim" },
    ]);
  });

  await test("visibleWidth/fitLine: ANSI-aware width and truncation", () => {
    const dim = "\u001b[2m";
    const reset = "\u001b[0m";
    assert.equal(strata.visibleWidth(`${dim}abcd${reset}ef`), 6);
    assert.equal(strata.visibleWidth("plain"), 5);
    // short lines pass through untouched
    assert.equal(
      strata.fitLine(`${dim}ab${reset}cd`, 10),
      `${dim}ab${reset}cd`,
    );
    // long plain lines: truncated with an ellipsis, exactly width cells
    const long = "x".repeat(40);
    const fitted = strata.fitLine(long, 10);
    assert.equal(fitted, `${"x".repeat(9)}…`);
    assert.equal(strata.visibleWidth(fitted), 10);
    // colored lines: escapes stay intact, not counted
    const colored = `${dim}${"y".repeat(40)}${reset}`;
    const fittedColor = strata.fitLine(colored, 10);
    assert.equal(fittedColor, `${dim}${"y".repeat(9)}…`);
    assert.equal(strata.visibleWidth(fittedColor), 10);
  });

  const workDir = mkdtempSync(join(tmpdir(), "pi-strata-test-"));
  const sDir = join(workDir, "session.pi_strata");

  await test("writeSnapshot: writes a disposable raw snapshot", () => {
    const snapPath = join(sDir, "tmp", "step_1_raw.md");
    strata.writeSnapshot(snapPath, "step 1", "raw text  \r\n");
    assert.ok(existsSync(snapPath));
    assert.ok(readFileSync(snapPath, "utf8").includes("raw text"));
  });

  await test("cleanupOrphanedStrataDirs removes strata dirs of deleted sessions", () => {
    const sessDir = join(workDir, "sessions");
    mkdirSync(sessDir, { recursive: true });
    const mk = (name) => {
      mkdirSync(join(sessDir, name, "tmp"), { recursive: true });
      writeFileSync(join(sessDir, name, "tmp", "step_1_raw.md"), "raw\n");
    };
    writeFileSync(join(sessDir, "a.jsonl"), "{}");
    mk("a.pi_strata");
    mk("b.pi_strata"); // b.jsonl is gone -> orphan
    writeFileSync(join(sessDir, "c.jsonl"), "{}");
    mk("c.pi_strata");
    writeFileSync(join(sessDir, "d.txt"), "not strata");
    const removed = strata.cleanupOrphanedStrataDirs(sessDir);
    assert.equal(removed, 1);
    assert.ok(existsSync(join(sessDir, "a.pi_strata")));
    assert.ok(!existsSync(join(sessDir, "b.pi_strata")));
    assert.ok(existsSync(join(sessDir, "c.pi_strata")));
    assert.ok(existsSync(join(sessDir, "d.txt")));
  });

  console.log("compaction.ts — session_before_compact");

  const { handleSessionBeforeCompact, previousLlmTail } = await jiti.import(
    join(here, "compaction.ts"),
  );

  // LLM-message fixtures for the summarized span.
  const userMsg = (text, ts) => ({
    role: "user",
    content: text,
    timestamp: ts ?? 1,
  });
  const assistantMsg = (text, ts) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: ts ?? 2,
  });

  const makeEvent = (opts = {}) => ({
    type: "session_before_compact",
    reason: "manual",
    willRetry: false,
    customInstructions: "test",
    signal: opts.signal ?? new AbortController().signal,
    branchEntries: opts.branchEntries ?? [
      { type: "session", id: "h" },
      { type: "message", id: "m1", message: userMsg("task text", 1) },
      { type: "message", id: "m2", message: assistantMsg("response text", 2) },
    ],
    preparation: {
      firstKeptEntryId: opts.firstKept ?? "m2",
      messagesToSummarize: opts.messages ?? [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1234,
      previousSummary: opts.previousSummary,
      fileOps: { readFiles: [], modifiedFiles: [] },
      settings: { reserveTokens: 16384, keepRecentTokens: 20000 },
    },
  });

  const makeRt = (pending) => ({
    strataDir: sDir,
    pending,
  });

  const makeCtx = (extra = {}) => ({
    cwd: workDir,
    hasUI: false,
    ui: { notify: () => {} },
    model: undefined,
    modelRegistry: undefined,
    ...extra,
  });

  await test("not a strata session -> undefined (default compaction)", async () => {
    const res = await handleSessionBeforeCompact(
      makeEvent({
        messages: [userMsg("task"), assistantMsg("hello, no markers here")],
      }),
      makeCtx(),
      makeRt(null),
    );
    assert.equal(res, undefined);
  });

  await test("plan mode: first compaction from conversation blocks", async () => {
    const event = makeEvent({
      messages: [
        userMsg("build a parser"),
        assistantMsg(`Investigation:\n${R}\n\nPlan:\n${PLAN1}`),
      ],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt({ kind: "plan" }),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.firstKeptEntryId, "m2");
    assert.equal(res.compaction.tokensBefore, 1234);
    assert.ok(res.compaction.summary.startsWith("## PI-STRATA CONTEXT (v1)"));
    assert.ok(
      res.compaction.summary.includes(
        "/*STRATA::RESEARCH::v1*/\nstack: node\nconstraints: local LLM",
      ),
    );
    assert.ok(
      res.compaction.summary.includes(
        "/*STRATA::PLAN::v1*/\n- [ ] write parser\n- [ ] add tests",
      ),
    );
    assert.equal(res.compaction.details.strata.mode, "plan");
  });

  await test("latest wins: newer PLAN block overrides the summary's plan", async () => {
    const prevSummary = strata.buildStrataSummary({
      research: "stack: node",
      plan: "- [ ] write parser\n- [ ] add tests",
    });
    const planV2 =
      "/*STRATA::PLAN::v1*/\n- [x] write parser\n- [ ] add tests\n- [ ] ship\n/*STRATA::END::PLAN::v1*/";
    const event = makeEvent({
      previousSummary: prevSummary,
      messages: [assistantMsg(`Plan updated:\n${planV2}`)],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt({ kind: "plan" }),
    );
    assert.ok(res?.compaction);
    assert.ok(
      res.compaction.summary.includes(
        "/*STRATA::PLAN::v1*/\n- [x] write parser\n- [ ] add tests\n- [ ] ship",
      ),
    );
    // research survived from the previous summary
    assert.ok(
      res.compaction.summary.includes("/*STRATA::RESEARCH::v1*/\nstack: node"),
    );
    // the stale plan bytes are gone
    assert.ok(
      !res.compaction.summary.includes(
        "- [ ] write parser\n- [ ] add tests\n/*STRATA::END::PLAN::v1*/",
      ),
    );
  });

  await test("new task: plan compaction drops the previous cycle's step reports", async () => {
    const prevSummary = strata.buildStrataSummary({
      research: "task one research",
      plan: "- [ ] write parser\n- [ ] add tests",
      reports: [
        { n: 1, text: "did write parser" },
        { n: 2, text: "did add tests" },
      ],
    });
    const r2 =
      "/*STRATA::RESEARCH::v1*/\nstack: node\n/*STRATA::END::RESEARCH::v1*/";
    const plan2 =
      "/*STRATA::PLAN::v1*/\n- [ ] build\n- [ ] test\n- [ ] ship\n/*STRATA::END::PLAN::v1*/";
    const event = makeEvent({
      previousSummary: prevSummary,
      messages: [assistantMsg(`New task.\n${r2}\n${plan2}`)],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt({ kind: "plan" }),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plan");
    // no stale step reports from the previous task
    assert.ok(!res.compaction.summary.includes("/*STRATA::STEP-1"));
    assert.ok(!res.compaction.summary.includes("/*STRATA::STEP-2"));
    assert.ok(!res.compaction.summary.includes("did write parser"));
    // the new cycle's blocks are present
    assert.ok(
      res.compaction.summary.includes("/*STRATA::RESEARCH::v1*/\nstack: node"),
    );
    assert.ok(
      res.compaction.summary.includes("- [ ] build\n- [ ] test\n- [ ] ship"),
    );
    assert.deepEqual(res.compaction.details.strata.reportFiles, []);
  });

  await test("previousLlmTail: strips the strata prefix, keeps the pi LLM tail", () => {
    assert.equal(previousLlmTail(undefined), undefined);
    const strataOnly = strata.buildStrataSummary({
      research: "stack: node",
      plan: "- [ ] a",
    });
    assert.equal(previousLlmTail(strataOnly), undefined);
    const tail = "## Goal\nbuild a parser\n\n## Progress\n- in progress: b";
    assert.equal(previousLlmTail(`${strataOnly}\n\n${tail}`), tail);
    // non-strata summaries are passed through untouched
    const nonStrata = "## Goal\nold pi summary";
    assert.equal(previousLlmTail(nonStrata), nonStrata);
  });

  await test("plain mode: mid-step compaction keeps the layers, no extras", async () => {
    const prevSummary = strata.buildStrataSummary({
      research: "stack: node",
      plan: "- [x] a\n- [ ] b",
    });
    const event = makeEvent({
      previousSummary: prevSummary,
      messages: [assistantMsg("working on b...")],
    });
    // no model in ctx -> deterministic layer dump only
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plain");
    assert.equal(res.compaction.details.strata.llmSummary, false);
    // Pi's default tail cut is kept untouched
    assert.equal(res.compaction.firstKeptEntryId, "m2");
    assert.ok(res.compaction.summary.includes("/*STRATA::RESEARCH::v1*/"));
    assert.ok(res.compaction.summary.includes("/*STRATA::PLAN::v1*/"));
  });

  await test("plain mode: pi LLM summary is appended on top of the strata sections", async () => {
    const prevSummary = strata.buildStrataSummary({
      research: "stack: node",
      plan: "- [x] a\n- [ ] b",
    });
    const oldTail =
      "## Goal\nbuild a parser\n\n## Progress\n### In Progress\n- [ ] b: half done";
    const event = makeEvent({
      previousSummary: `${prevSummary}\n\n${oldTail}`,
      messages: [assistantMsg("working on b...")],
    });
    let seen; // the preparation the summarizer received
    const usage = {
      input: 3,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const summarizer = async (prep) => {
      seen = prep;
      return {
        summary:
          "## Goal\nbuild a parser\n\n## Progress\n### Done\n- [x] a\n### In Progress\n- [ ] b",
        usage,
      };
    };
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
      { summarizePlain: summarizer },
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plain");
    assert.equal(res.compaction.details.strata.llmSummary, true);
    // the strata prefix is byte-identical, the LLM tail follows it
    assert.equal(
      res.compaction.summary.slice(0, prevSummary.length),
      prevSummary,
    );
    assert.ok(res.compaction.summary.includes("### In Progress\n- [ ] b"));
    assert.equal(res.compaction.usage, usage);
    // the LLM merges its own previous tail, never the strata sections
    assert.equal(seen.previousSummary, oldTail);
    assert.equal(seen.messagesToSummarize.length, 1);
  });

  await test("plain mode: summarizer failure falls back to the layer dump", async () => {
    let warnings = 0;
    const ctx = makeCtx({
      hasUI: true,
      ui: {
        notify: (_message, type) => {
          if (type === "warning") warnings += 1;
        },
      },
    });
    const layers = { research: "stack: node", plan: "- [ ] a" };
    const event = makeEvent({
      previousSummary: strata.buildStrataSummary(layers),
      messages: [assistantMsg("working...")],
    });
    const res = await handleSessionBeforeCompact(event, ctx, makeRt(null), {
      summarizePlain: async () => {
        throw new Error("llm down");
      },
    });
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plain");
    assert.equal(res.compaction.details.strata.llmSummary, false);
    assert.equal(res.compaction.summary, strata.buildStrataSummary(layers));
    assert.equal(warnings, 1);
  });

  await test("plain mode: aborted summarization cancels the compaction", async () => {
    const ac = new AbortController();
    ac.abort();
    const event = makeEvent({
      previousSummary: strata.buildStrataSummary({
        research: "stack: node",
        plan: "- [ ] a",
      }),
      messages: [assistantMsg("working...")],
      signal: ac.signal,
    });
    await assert.rejects(
      handleSessionBeforeCompact(event, makeCtx(), makeRt(null), {
        summarizePlain: async (_prep, _ctx, signal) => {
          if (signal.aborted) throw new Error("aborted");
          return { summary: "x" };
        },
      }),
      /aborted/,
    );
  });

  await test("plain mode sees PLAN markers kept in Pi's recent tail", async () => {
    const event = makeEvent({
      firstKept: "m2",
      messages: [assistantMsg("working; old logs are being compacted")],
      branchEntries: [
        { type: "session", id: "h" },
        { type: "message", id: "m1", message: userMsg("task text", 1) },
        {
          type: "message",
          id: "m2",
          message: assistantMsg(`${R}\n${PLAN1}`, 2),
        },
      ],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plain");
    assert.ok(res.compaction.summary.includes("/*STRATA::RESEARCH::v1*/"));
    assert.ok(res.compaction.summary.includes("/*STRATA::PLAN::v1*/"));
  });

  await test("plain mode: a research-only session keeps the research block", async () => {
    const event = makeEvent({
      previousSummary: strata.buildStrataSummary({
        research: "user goal: add import\nfound: parser lives in src/parser.ts",
      }),
      messages: [assistantMsg("checking import edge cases...")],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plain");
    assert.ok(
      res.compaction.summary.includes("found: parser lives in src/parser.ts"),
    );
  });

  await test("step mode: snapshot written, deterministic summary", async () => {
    const prevSummary = strata.buildStrataSummary({
      research: "stack: node",
      plan: "- [ ] write parser\n- [ ] add tests",
    });
    const step1 =
      "/*STRATA::STEP-1::v1*/\nimplemented a; files: src/a.ts; tests green\n/*STRATA::END::STEP-1::v1*/";
    const event = makeEvent({
      previousSummary: prevSummary,
      messages: [assistantMsg(`${PLAN1_DONE}\n${step1}`)],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt({ kind: "step", stepN: 1 }),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "step");
    assert.equal(res.compaction.details.strata.stepN, 1);
    assert.ok(
      res.compaction.summary.includes(
        "/*STRATA::STEP-1::v1*/\nimplemented a; files: src/a.ts; tests green",
      ),
    );
    assert.ok(res.compaction.summary.includes("- [x] write parser"));
    assert.ok(existsSync(join(sDir, "tmp", "step_1_raw.md")));
  });

  await test("summary round-trip through compaction: re-extraction is byte-identical", async () => {
    const s1 = strata.buildStrataSummary({
      research: "stack: node",
      plan: "- [x] a\n- [x] b",
      reports: [
        { n: 1, text: "did a" },
        { n: 2, text: "did b" },
      ],
    });
    const event = makeEvent({
      previousSummary: s1,
      messages: [assistantMsg("all done, nothing new")],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plain");
    assert.equal(res.compaction.summary, s1);
  });

  await test("completed plan compacts as plain mode", async () => {
    const event = makeEvent({
      previousSummary: strata.buildStrataSummary({
        research: "stack: node",
        plan: "- [ ] a\n- [ ] b",
        reports: [
          { n: 1, text: "did a" },
          { n: 2, text: "did b" },
        ],
      }),
      messages: [assistantMsg("final response")],
    });
    const res = await handleSessionBeforeCompact(
      event,
      makeCtx(),
      makeRt(null),
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plain");
  });

  console.log("config.ts — env > config > default");

  const config = await jiti.import(join(here, "config.ts"));
  const STRATA_ENV = ["PI_STRATA_AUTO_CONTINUE", "PI_STRATA_HIDE_ANCHORS"];
  const savedEnv = Object.fromEntries(
    STRATA_ENV.map((k) => [k, process.env[k]]),
  );
  const clearStrataEnv = () => {
    for (const k of STRATA_ENV) delete process.env[k];
  };
  const noSettings = join(workDir, "no-such-settings.json");
  const globalSettings = join(workDir, "global-settings.json");
  const projectSettings = join(workDir, ".pi", "settings.json");
  const writeSettings = (file, obj) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj));
  };

  try {
    await test("defaults: no env, no settings files", () => {
      clearStrataEnv();
      assert.deepEqual(config.resolveStrataSettings(workDir, noSettings), {
        autoContinue: true,
        hideAnchors: true,
      });
    });

    await test("global config file applies", () => {
      clearStrataEnv();
      writeSettings(globalSettings, { piStrata: { autoContinue: false } });
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: false,
        hideAnchors: true,
      });
    });

    await test("project config overrides global per field", () => {
      clearStrataEnv();
      writeSettings(globalSettings, {
        piStrata: { autoContinue: false },
      });
      writeSettings(projectSettings, {
        piStrata: { autoContinue: true },
      });
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: true,
        hideAnchors: true,
      });
    });

    await test("env overrides config", () => {
      process.env.PI_STRATA_AUTO_CONTINUE = "0";
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: false,
        hideAnchors: true,
      });
    });

    await test("hideAnchors: config applies, env 0/1 override", () => {
      clearStrataEnv();
      writeSettings(globalSettings, { piStrata: { hideAnchors: false } });
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: true,
        hideAnchors: false,
      });
      process.env.PI_STRATA_HIDE_ANCHORS = "1";
      assert.equal(
        config.resolveStrataSettings(workDir, globalSettings).hideAnchors,
        true,
      );
      process.env.PI_STRATA_HIDE_ANCHORS = "0";
      assert.equal(
        config.resolveStrataSettings(workDir, globalSettings).hideAnchors,
        false,
      );
    });

    await test("legacy enabled in config is ignored (session state now)", () => {
      clearStrataEnv();
      writeSettings(globalSettings, { piStrata: { enabled: false } });
      // `enabled` is no longer a config field — it must not leak into the
      // resolved settings at all (the mode is per-session, off by default)
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: true,
        hideAnchors: true,
      });
    });

    await test("invalid values fall through to lower levels", () => {
      clearStrataEnv();
      writeSettings(globalSettings, {
        piStrata: {
          autoContinue: "yes", // not a boolean -> ignored
          hideAnchors: "yes", // not a boolean -> ignored
        },
      });
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: true, // invalid config -> default
        hideAnchors: true, // invalid config -> default
      });
      process.env.PI_STRATA_AUTO_CONTINUE = "1";
      assert.equal(
        config.resolveStrataSettings(workDir, globalSettings).autoContinue,
        true,
      );
    });

    await test("invalid settings.json / missing key are ignored", () => {
      clearStrataEnv();
      writeSettings(globalSettings, "{ not json");
      writeSettings(projectSettings, { theme: "dark" });
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: true,
        hideAnchors: true,
      });
    });
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  console.log("index.ts — extension wiring + tool");

  const factory = (await jiti.import(join(here, "index.ts"))).default;
  const handlers = {};
  const tools = {};
  const commands = {};
  const transformers = [];
  const sentMessages = [];
  const mockPi = {
    on: (name, handler) => {
      handlers[name] ??= [];
      handlers[name].push(handler);
    },
    registerTool: (t) => {
      tools[t.name] = t;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    registerMarkdownTransformer: (fn) => {
      transformers.push(fn);
    },
    registerMessageRenderer: () => {},
    sendUserMessage: () => {},
    sendMessage: (msg, opts) => {
      sentMessages.push({ msg, opts });
    },
  };

  factory(mockPi);

  await test("factory registers all events, tool and command", () => {
    for (const name of [
      "session_start",
      "before_agent_start",
      "session_before_compact",
      "agent_settled",
      "turn_end",
      "session_compact",
    ]) {
      assert.ok(handlers[name]?.length, `missing handler: ${name}`);
    }
    assert.ok(tools.strata, "missing tool: strata");
    assert.ok(commands.strata, "missing command: /strata");
    assert.ok(commands["strata-on"], "missing command: /strata-on");
    assert.ok(transformers.length >= 1, "missing markdown transformer");
  });

  // Mutable branch shared by the tool tests (branchText scans it).
  const branch = [];
  const branchMsg = (text, id) => ({
    type: "message",
    id,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  });

  const tCtx = {
    cwd: workDir,
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: {
      getSessionFile: () => join(workDir, "2026.jsonl"),
      getSessionId: () => "test-session",
      getBranch: () => branch,
    },
    getContextUsage: () => ({
      tokens: null,
      contextWindow: 8000,
      percent: null,
    }),
    compact: () => {},
  };
  const tDir = join(workDir, "2026.pi_strata");
  const tP = strata.strataPaths(tDir);

  // establish the session (sets rt.strataDir from the session file path)
  handlers.session_start[0]({ type: "session_start" }, tCtx);

  // Anchor-display tests: pin the effective config (project settings file +
  // a session_start re-resolve) so the assertions never depend on the
  // machine's real global settings.
  writeFileSync(join(workDir, "2026.jsonl"), "");
  writeSettings(projectSettings, { piStrata: { hideAnchors: true } });
  handlers.session_start[0]({ type: "session_start" }, tCtx);

  await test("markdown transformer hides STRATA anchors (display-only)", () => {
    const t = transformers[transformers.length - 1];
    const ctx = {
      messageType: "assistant",
      isStreaming: false,
      availableWidth: 100,
    };
    const md = `Привет!\n\n${R}\n\n${PLAN1}`;
    const out = t(md, ctx);
    assert.ok(!out.includes("STRATA::"), "anchors hidden in assistant text");
    assert.ok(out.includes("stack: node"), "research body kept");
    assert.ok(out.includes("- [ ] write parser"), "plan body kept");
    // thinking blocks are transformed like assistant text (incl. streaming)
    assert.ok(
      !t(R, {
        messageType: "assistant-thinking",
        isStreaming: true,
        availableWidth: 100,
      }).includes("STRATA::"),
    );
    // user messages are untouched
    assert.equal(
      t(md, { messageType: "user", isStreaming: false, availableWidth: 100 }),
      md,
    );
    // idempotent on re-render (terminal resize re-runs the chain)
    assert.equal(t(out, ctx), out);
  });

  await test("hideAnchors: config toggle re-resolved on session_start", async () => {
    const t = transformers[transformers.length - 1];
    const ctx = {
      messageType: "assistant",
      isStreaming: false,
      availableWidth: 100,
    };
    const md = `x\n\n${R}`;
    const statusText = async () => {
      const r = await tools.strata.execute(
        "s-anchor",
        { action: "status" },
        undefined,
        undefined,
        tCtx,
      );
      return r.content[0].text;
    };
    const savedEnv = process.env.PI_STRATA_HIDE_ANCHORS;
    try {
      // project config: show the anchors
      delete process.env.PI_STRATA_HIDE_ANCHORS;
      writeSettings(projectSettings, { piStrata: { hideAnchors: false } });
      handlers.session_start[0]({ type: "session_start" }, tCtx);
      assert.ok(t(md, ctx).includes("STRATA::"), "hideAnchors=false shows");
      assert.ok((await statusText()).includes("anchors=shown"));

      // project config: hide the anchors again
      writeSettings(projectSettings, { piStrata: { hideAnchors: true } });
      handlers.session_start[0]({ type: "session_start" }, tCtx);
      assert.ok(!t(md, ctx).includes("STRATA::"), "hideAnchors=true hides");
      assert.ok((await statusText()).includes("anchors=hidden"));

      // env "0" overrides config true
      process.env.PI_STRATA_HIDE_ANCHORS = "0";
      handlers.session_start[0]({ type: "session_start" }, tCtx);
      assert.ok(t(md, ctx).includes("STRATA::"), "env 0 shows");

      // env "1" overrides config false
      writeSettings(projectSettings, { piStrata: { hideAnchors: false } });
      process.env.PI_STRATA_HIDE_ANCHORS = "1";
      handlers.session_start[0]({ type: "session_start" }, tCtx);
      assert.ok(!t(md, ctx).includes("STRATA::"), "env 1 hides");
    } finally {
      if (savedEnv === undefined) delete process.env.PI_STRATA_HIDE_ANCHORS;
      else process.env.PI_STRATA_HIDE_ANCHORS = savedEnv;
      // leave the session in the default hidden state for later tests
      writeSettings(projectSettings, { piStrata: { hideAnchors: true } });
      handlers.session_start[0]({ type: "session_start" }, tCtx);
    }
  });

  await test("reload: compaction rehydrates session state without session_start", async () => {
    const reloadedHandlers = {};
    const reloadedCommands = {};
    factory({
      on: (name, handler) => {
        reloadedHandlers[name] ??= [];
        reloadedHandlers[name].push(handler);
      },
      registerTool: () => {},
      registerCommand: (name, def) => {
        reloadedCommands[name] = def;
      },
      registerMarkdownTransformer: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: () => {},
    });
    // a /reload starts a fresh runtime: the mode is off again — opt in
    await reloadedCommands["strata-on"].handler("", tCtx);
    const res = await reloadedHandlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      tCtx,
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plain");
  });

  await test("before_agent_start injects static instructions (layer 0)", async () => {
    // the session started off (default): opt in for this test
    await commands["strata-on"].handler("", tCtx);
    const res = handlers.before_agent_start[0]({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "BASE SYSTEM",
      systemPromptOptions: {},
    });
    assert.ok(res.systemPrompt.startsWith("BASE SYSTEM\n\n"));
    assert.ok(res.systemPrompt.includes("PI-STRATA"));
    assert.ok(res.systemPrompt.includes("/*STRATA::RESEARCH::v1*/"));
    assert.ok(res.systemPrompt.includes("/*STRATA::PLAN::v1*/"));
    assert.ok(res.systemPrompt.includes("/*STRATA::STEP-N::v1*/"));
    assert.ok(res.systemPrompt.includes(tP.tmp));
    // static: two calls give identical bytes
    assert.equal(
      res.systemPrompt,
      handlers.before_agent_start[0]({
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: "BASE SYSTEM",
        systemPromptOptions: {},
      }).systemPrompt,
    );
  });

  const exec = tools.strata.execute;

  // Widgets are pi-lens-style component factories now: render them with a
  // plain (colorless) theme to get the line text.
  const plainTheme = { fg: (_color, text) => text };
  const renderWidget = (content, width = 200) =>
    typeof content === "function"
      ? content({}, plainTheme).render(width)
      : content;

  await test("mode: off by default; /strata-on enables it for the session only", async () => {
    const notifs = [];
    const widgets = {};
    const cmdCtx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (msg, level) => notifs.push([msg, level]),
        setWidget: (key, content, opts) => {
          widgets[key] = [content, opts];
        },
        confirm: async () => true,
      },
    };
    // fresh session: the mode is off by default (no settings/env involved)
    handlers.session_start[0]({ type: "session_start" }, cmdCtx);
    assert.deepEqual(renderWidget(widgets["strata-mode"][0]), [" strata  off"]);
    assert.equal(widgets["strata-mode"][1].placement, "belowEditor");

    // no layer-0 instructions
    assert.equal(
      handlers.before_agent_start[0]({
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: "BASE",
        systemPromptOptions: {},
      }),
      undefined,
    );

    // pi's default compaction (no strata summary)
    const res = await handlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      cmdCtx,
    );
    assert.equal(res, undefined);

    // advance is refused
    const e = await exec(
      "dis-1",
      { action: "advance" },
      undefined,
      undefined,
      cmdCtx,
    );
    assert.ok(e.isError);
    assert.ok(e.content[0].text.includes("disabled"));
    assert.ok(e.content[0].text.includes("/strata-on"));

    // status reports the mode
    const s = await exec(
      "dis-2",
      { action: "status" },
      undefined,
      undefined,
      cmdCtx,
    );
    assert.ok(s.content[0].text.includes("enabled: off"));

    // /strata-on: session-scoped enable, no settings file is written
    const settingsBefore = readFileSync(projectSettings, "utf8");
    await commands["strata-on"].handler("", cmdCtx);
    assert.equal(
      readFileSync(projectSettings, "utf8"),
      settingsBefore,
      "no settings file written",
    );
    assert.deepEqual(renderWidget(widgets["strata-mode"][0]), [" strata  on"]);
    assert.ok(notifs.some(([m, l]) => l === "info" && m.includes("enabled")));

    // strata compaction and instructions come back
    const res2 = await handlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      cmdCtx,
    );
    assert.ok(res2?.compaction, "strata compaction back when enabled");
    assert.ok(
      handlers.before_agent_start[0]({
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: "BASE",
        systemPromptOptions: {},
      }).systemPrompt.includes("PI-STRATA"),
    );
    const s2 = await exec(
      "dis-3",
      { action: "status" },
      undefined,
      undefined,
      cmdCtx,
    );
    assert.ok(s2.content[0].text.includes("enabled: on"));

    // a new session starts off again (the mode is not persisted)
    handlers.session_start[0]({ type: "session_start" }, cmdCtx);
    assert.deepEqual(renderWidget(widgets["strata-mode"][0]), [" strata  off"]);
  });

  await test("strata-on: idempotent when already on", async () => {
    const notifs = [];
    const cmdCtx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (msg) => notifs.push(msg),
        setWidget: () => {},
        confirm: async () => true,
      },
    };
    await commands["strata-on"].handler("", cmdCtx);
    await commands["strata-on"].handler("", cmdCtx);
    assert.ok(notifs.some((m) => m.includes("already on")));
    const s = await exec(
      "dis-4",
      { action: "status" },
      undefined,
      undefined,
      cmdCtx,
    );
    assert.ok(s.content[0].text.includes("enabled: on"));
  });

  await test("strata-on on an existing session defers the system prompt (KV-cache guard)", async () => {
    const sent = [];
    const h = {};
    const cmds = {};
    const toolsA = {};
    factory({
      on: (name, handler) => {
        h[name] ??= [];
        h[name].push(handler);
      },
      registerTool: (t) => {
        toolsA[t.name] = t;
      },
      registerCommand: (name, def) => {
        cmds[name] = def;
      },
      registerMarkdownTransformer: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: (msg, opts) => sent.push({ msg, opts }),
    });
    const notes = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (message, level) => notes.push([level, message]),
        setWidget: () => {},
        confirm: async () => true,
      },
    };
    h.session_start[0]({ type: "session_start" }, ctx);
    // the session already carries context (a message in the branch):
    branch.length = 0;
    branch.push(branchMsg("earlier work", "e1"));
    await cmds["strata-on"].handler("", ctx);
    // standing instructions queued for the next turn (end of the context):
    assert.equal(sent.length, 1, "one instructions message queued");
    assert.deepEqual(sent[0].opts, { deliverAs: "nextTurn" });
    assert.equal(sent[0].msg.customType, "strata-instructions");
    assert.equal(sent[0].msg.display, true);
    assert.ok(sent[0].msg.content.includes("/*STRATA::RESEARCH::v1*/"));
    assert.ok(sent[0].msg.content.includes(tP.tmp));
    assert.ok(
      notes.some(
        ([level, message]) =>
          level === "info" && message.includes("KV cache preserved"),
      ),
    );
    // the system prompt is untouched until the next compaction:
    assert.equal(
      h.before_agent_start[0]({
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: "BASE SYSTEM",
        systemPromptOptions: {},
      }),
      undefined,
    );
    const statusA = (id) =>
      toolsA.strata.execute(
        id,
        { action: "status" },
        undefined,
        undefined,
        ctx,
      );
    const s1 = await statusA("kv-1");
    assert.ok(s1.content[0].text.includes("sysprompt: deferred"));
    // the next compaction rewrites the context: the deferral is lifted and
    // the system prompt picks the instructions up from the next turn on:
    h.session_compact[0](
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "cA",
          summary: "s",
          firstKeptEntryId: "m2",
          tokensBefore: 1,
          fromHook: true,
          details: {},
        },
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      },
      ctx,
    );
    const res = h.before_agent_start[0]({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "BASE SYSTEM",
      systemPromptOptions: {},
    });
    assert.ok(res.systemPrompt.startsWith("BASE SYSTEM\n\n"));
    assert.ok(res.systemPrompt.includes("PI-STRATA"));
    const s2 = await statusA("kv-2");
    assert.ok(s2.content[0].text.includes("sysprompt: active"));
    assert.ok(
      notes.some(
        ([level, message]) =>
          level === "info" && message.includes("moved to the system prompt"),
      ),
    );
  });

  await test("strata-on queues instructions for an existing headless session", async () => {
    const sent = [];
    const h = {};
    const cmds = {};
    factory({
      on: (name, handler) => {
        h[name] ??= [];
        h[name].push(handler);
      },
      registerTool: () => {},
      registerCommand: (name, def) => {
        cmds[name] = def;
      },
      registerMarkdownTransformer: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: (msg, opts) => sent.push({ msg, opts }),
    });
    const ctx = { ...tCtx, hasUI: false };
    h.session_start[0]({ type: "session_start" }, ctx);
    branch.length = 0;
    branch.push(branchMsg("earlier work", "headless-1"));

    await cmds["strata-on"].handler("", ctx);

    assert.equal(sent.length, 1, "instructions queued without a TUI");
    assert.deepEqual(sent[0].opts, { deliverAs: "nextTurn" });
    assert.equal(sent[0].msg.customType, "strata-instructions");
    assert.ok(sent[0].msg.content.includes("/*STRATA::STEP-N::v1*/"));
  });

  await test("strata-on on an empty session updates the system prompt immediately", async () => {
    const sent = [];
    const h = {};
    const cmds = {};
    factory({
      on: (name, handler) => {
        h[name] ??= [];
        h[name].push(handler);
      },
      registerTool: () => {},
      registerCommand: (name, def) => {
        cmds[name] = def;
      },
      registerMarkdownTransformer: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: (msg, opts) => sent.push({ msg, opts }),
    });
    h.session_start[0]({ type: "session_start" }, tCtx);
    branch.length = 0; // fresh session: no LLM context yet
    await cmds["strata-on"].handler("", tCtx);
    assert.equal(sent.length, 0, "no message queued on a fresh session");
    const res = h.before_agent_start[0]({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "BASE SYSTEM",
      systemPromptOptions: {},
    });
    assert.ok(res.systemPrompt.startsWith("BASE SYSTEM\n\n"));
    assert.ok(res.systemPrompt.includes("PI-STRATA"));
  });

  await test("advance: validation errors (no blocks / no plan / step without report / unchecked item)", async () => {
    branch.length = 0;
    const e0 = await exec(
      "a0",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(e0.isError, "no STRATA:: blocks at all");

    branch.push(branchMsg(`Investigation:\n${R}`, "b1"));
    const e1 = await exec(
      "a1",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(e1.isError, "research only, no PLAN");

    branch.push(branchMsg(`Plan:\n${PLAN1}`, "b2"));
    const e2 = await exec(
      "a2",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(e2.isError, "no STEP-1 block");

    const step1 = "/*STRATA::STEP-1::v1*/\nreport\n/*STRATA::END::STEP-1::v1*/";
    branch.push(branchMsg(`${PLAN1}\n${step1}`, "b3"));
    const e3 = await exec(
      "a3",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!e3.isError, "STEP-1 report is the completion record");
  });

  await test("advance: plan accepted -> first compaction queued", async () => {
    branch.length = 0;
    branch.push(branchMsg(`Investigation:\n${R}\n\nPlan:\n${PLAN1}`, "b4"));
    const r = await exec(
      "a4",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!r.isError);
    assert.ok(r.content[0].text.includes("write parser"));
    assert.ok(r.content[0].text.includes("advance"));
  });

  await test("advance step: accepted with immutable plan + STEP block", async () => {
    branch.length = 0;
    branch.push({
      type: "compaction",
      id: "c1",
      summary: strata.buildStrataSummary({
        research: "stack: node",
        plan: "- [ ] write parser\n- [ ] add tests",
      }),
    });
    branch.push(
      branchMsg(
        `/*STRATA::STEP-1::v1*/
implemented parser; files: src/parser.ts; tests green
/*STRATA::END::STEP-1::v1*/`,
        "b5",
      ),
    );
    const r = await exec(
      "a5",
      { action: "advance", step: 1 },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!r.isError);
    assert.ok(r.content[0].text.includes("step_1_raw.md"));
    assert.ok(r.content[0].text.includes("add tests"));
  });

  await test("status: reports extracted plan state", async () => {
    const r = await exec(
      "a6",
      { action: "status" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!r.isError);
    assert.ok(r.content[0].text.includes("research: yes"));
    assert.ok(r.content[0].text.includes("enabled: on"));
    assert.ok(r.content[0].text.includes("plan: 1/2"));
    assert.ok(r.content[0].text.includes("reports: [1]"));
  });

  await test("agent_settled fires queued compact", async () => {
    let compacted = null;
    const ctx = { ...tCtx, compact: (opts) => (compacted = opts) };
    await handlers.agent_settled[0]({ type: "agent_settled" }, ctx);
    assert.ok(compacted);
    assert.ok(compacted.customInstructions.startsWith("step:1"));
  });

  await test("queued step survives agent_settled and is consumed by compaction", async () => {
    const event = makeEvent({
      previousSummary: strata.buildStrataSummary({
        research: "stack: node",
        plan: "- [ ] write parser\n- [ ] add tests",
      }),
      messagesToSummarize: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `${PLAN1_DONE}\n/*STRATA::STEP-1::v1*/\nreport\n/*STRATA::END::STEP-1::v1*/`,
            },
          ],
        },
      ],
    });
    const res = await handlers.session_before_compact[0](event, tCtx);
    assert.equal(res.compaction.details.strata.mode, "step");
    assert.equal(res.compaction.details.strata.stepN, 1);
    const status = await exec(
      "a7",
      { action: "status" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(status.content[0].text.includes("pending: none"));
  });

  await test("failed small-session phase compaction clears the pending marker", async () => {
    branch.length = 0;
    branch.push(branchMsg(`${R}\n${PLAN1}`, "b-small"));
    const accepted = await exec(
      "a-small",
      { action: "advance" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(!accepted.isError);
    let requested = null;
    const ctx = { ...tCtx, compact: (opts) => (requested = opts) };
    await handlers.agent_settled[0]({ type: "agent_settled" }, ctx);
    assert.ok(requested?.onError);
    requested.onError(new Error("Nothing to compact (session too small)"));
    const status = await exec(
      "a-small-status",
      { action: "status" },
      undefined,
      undefined,
      tCtx,
    );
    assert.ok(status.content[0].text.includes("pending: none"));
  });

  await test("turn_end updates the plan dashboard widget", async () => {
    branch.length = 0;
    branch.push(branchMsg(`Plan:\n${PLAN1}`, "w1"));
    branch.push(
      branchMsg(
        `${PLAN1}\n/*STRATA::STEP-1::v1*/\nparser done\n/*STRATA::END::STEP-1::v1*/`,
        "w2",
      ),
    );
    const widgets = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: (key, lines) => widgets.push([key, lines]),
      },
    };
    const lastSet = (key) => {
      for (let i = widgets.length - 1; i >= 0; i--)
        if (widgets[i][0] === key) return widgets[i];
      return null;
    };
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    assert.deepEqual(renderWidget(lastSet("strata")[1]), [
      " strata  1/2 ✓▶  next: #2 add tests",
    ]);
    // the mode indicator is redundant while the dashboard is visible
    assert.deepEqual(lastSet("strata-mode"), ["strata-mode", undefined]);
    // non-strata branch: dashboard hidden, mode indicator back
    branch.length = 0;
    branch.push(branchMsg("hello", "w3"));
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    assert.equal(lastSet("strata")[1], undefined);
    assert.deepEqual(renderWidget(lastSet("strata-mode")[1]), [" strata  on"]);
  });

  await test("turn_end widget: next label is the item part before the first colon", async () => {
    branch.length = 0;
    branch.push(
      branchMsg(
        `Plan:\n/*STRATA::PLAN::v1*/\n- [ ] Step 1 (Makefile): add build and test targets to the Makefile\n- [ ] ship\n/*STRATA::END::PLAN::v1*/`,
        "w4",
      ),
    );
    const widgets = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: (key, lines) => widgets.push([key, lines]),
      },
    };
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    // the first set of the turn is the dashboard (the mode widget is
    // cleared behind it — redundant while the dashboard is visible)
    assert.deepEqual(renderWidget(widgets[0][1]), [
      " strata  0/2 ▶·  next: #1 Step 1 (Makefile)",
    ]);
    // narrow terminal: the line is fitted to the width, not wrapped
    const narrow = renderWidget(widgets[0][1], 20);
    assert.equal(strata.visibleWidth(narrow[0]), 20);
    assert.ok(narrow[0].endsWith("…"));
  });

  await test("turn_end widget: colon-less next label is truncated at 56", async () => {
    // no colon in the item: the full text is the label (the colon is
    // replaced by a comma on purpose — a colon would cut it first)
    const long =
      "update the blocksToLayers test in check.cjs, the report before the new PLAN is now dropped";
    branch.length = 0;
    branch.push(
      branchMsg(
        `Plan:\n/*STRATA::PLAN::v1*/\n- [ ] ${long}\n/*STRATA::END::PLAN::v1*/`,
        "w5",
      ),
    );
    const widgets = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: (key, lines) => widgets.push([key, lines]),
      },
    };
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    assert.deepEqual(renderWidget(widgets[0][1]), [
      ` strata  0/1 ▶  next: #1 ${long.slice(0, 55)}…`,
    ]);
  });

  await test("session_compact warns when another extension replaced the strata result", async () => {
    const notes = [];
    const ctx = {
      ...tCtx,
      hasUI: true,
      ui: {
        notify: (message, type) => notes.push([type, message]),
        setWidget: () => {},
      },
    };
    // the before handler returns a strata result (marks compactOurs)
    const before = await handlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      ctx,
    );
    assert.ok(before?.compaction);
    assert.ok(before.compaction.details.strata);
    notes.length = 0; // drop the plain-mode no-model fallback note

    // normal: our own entry was saved -> info, no warning
    handlers.session_compact[0](
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "c-own",
          summary: before.compaction.summary,
          firstKeptEntryId: "m2",
          tokensBefore: 1234,
          fromHook: true,
          details: before.compaction.details,
        },
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      },
      ctx,
    );
    assert.ok(notes.some(([type]) => type === "info"));
    assert.ok(!notes.some(([type]) => type === "warning"));

    // conflict: another extension's entry (no strata marker) was saved
    handlers.session_compact[0](
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "c-foreign",
          summary: "foreign summary",
          firstKeptEntryId: "m2",
          tokensBefore: 1234,
          fromHook: true,
        },
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      },
      ctx,
    );
    assert.ok(
      notes.some(
        ([type, message]) =>
          type === "warning" && message.includes("replaced it"),
      ),
    );
  });

  await test("agent_settled with no pending request does nothing", async () => {
    branch.length = 0;
    branch.push(branchMsg(`${R}\n${PLAN1}`, "b-idle"));
    let compacted = null;
    const ctx = { ...tCtx, compact: (opts) => (compacted = opts) };
    await handlers.agent_settled[0]({ type: "agent_settled" }, ctx);
    assert.equal(compacted, null);
  });

  rmSync(workDir, { recursive: true, force: true });
  console.log(`\n${passed} tests passed`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
