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
    assert.deepEqual(layers.reports, [
      { n: 1, text: "new" },
      { n: 2, text: "did b" },
    ]);
    assert.equal(strata.blocksToLayers([]), undefined);
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
  const STRATA_ENV = ["PI_STRATA_AUTO_CONTINUE"];
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
      });
    });

    await test("global config file applies", () => {
      clearStrataEnv();
      writeSettings(globalSettings, { piStrata: { autoContinue: false } });
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: false,
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
      });
    });

    await test("env overrides config", () => {
      process.env.PI_STRATA_AUTO_CONTINUE = "0";
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: false,
      });
    });

    await test("invalid values fall through to lower levels", () => {
      clearStrataEnv();
      writeSettings(globalSettings, {
        piStrata: {
          autoContinue: "yes", // not a boolean -> ignored
        },
      });
      assert.deepEqual(config.resolveStrataSettings(workDir, globalSettings), {
        autoContinue: true, // invalid config -> default
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
  const mockPi = {
    on: (name, handler) => {
      (handlers[name] ??= []).push(handler);
    },
    registerTool: (t) => {
      tools[t.name] = t;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    sendUserMessage: () => {},
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

  await test("reload: compaction rehydrates session state without session_start", async () => {
    const reloadedHandlers = {};
    factory({
      on: (name, handler) => {
        (reloadedHandlers[name] ??= []).push(handler);
      },
      registerTool: () => {},
      registerCommand: () => {},
      sendUserMessage: () => {},
    });
    const res = await reloadedHandlers.session_before_compact[0](
      makeEvent({ messages: [assistantMsg(`${R}\n${PLAN1}`)] }),
      tCtx,
    );
    assert.ok(res?.compaction);
    assert.equal(res.compaction.details.strata.mode, "plain");
  });

  await test("before_agent_start injects static instructions (layer 0)", () => {
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
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    assert.deepEqual(widgets[widgets.length - 1], [
      "strata",
      ["strata ▸ 1/2 ✓▶  next: #2 add tests"],
    ]);
    // non-strata branch: the widget is hidden again
    branch.length = 0;
    branch.push(branchMsg("hello", "w3"));
    handlers.turn_end[0]({ type: "turn_end" }, ctx);
    assert.equal(widgets[widgets.length - 1][1], undefined);
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
