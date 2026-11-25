import { parseNow, laneFor, renderBoard, buildBoard } from "../src/worker.js";
import assert from "node:assert";

const now = Date.parse("2026-10-31T14:00:00Z");
const d = (n) => new Date(now - n * 86400000).toISOString();
const NOW = `Doing: redesign
Next step: review PR #47
Updated: 2026-10-31`;
const noPr = { totalCount: 0, nodes: [] };
const pr = (days) => ({ totalCount: 1, nodes: [{ number: 47, title: "Scroll", url: "p", updatedAt: d(days) }] });
const repo = (o) => ({ name: "r", url: "u", pushedAt: d(0), isPrivate: false, isArchived: false, now: null, pullRequests: noPr, ...o });

const failures = [];
function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL: ${name}\n  ${err.message.replace(/\n/g, "\n  ")}`);
  }
}

// --- parseNow ---------------------------------------------------------------
test("parseNow: null and empty input return null", () => {
  assert.strictEqual(parseNow(null), null);
  assert.strictEqual(parseNow(""), null);
  assert.strictEqual(parseNow(undefined), null);
});

test('parseNow: keys are case-insensitive ("NEXT STEP: x" -> "next step")', () => {
  assert.deepStrictEqual(parseNow("NEXT STEP: x"), { "next step": "x" });
  assert.deepStrictEqual(
    parseNow("DOING: build\nSTATE: ready\nNEXT STEP: x\nBLOCKED BY: none\nUPDATED: 2026-10-31\nEPITAPH: done"),
    { doing: "build", state: "ready", "next step": "x", "blocked by": "none", updated: "2026-10-31", epitaph: "done" },
  );
});

// KNOWN FAILURE (src/worker.js parseNow):
// parseNow splits on "\n" without stripping "\r", and `.` in its regex
// (/^\s*(...)\s*:\s*(.+)$/i) does not match "\r", so CRLF-terminated lines
// fail to match at all instead of returning values without "\r".
test("parseNow: Windows CRLF line endings give values without \\r [KNOWN FAILURE]", () => {
  const res = parseNow("Doing: redesign\r\nNext step: ship\r\n");
  assert.deepStrictEqual(res, { doing: "redesign", "next step": "ship" });
  assert.strictEqual(res.doing.includes("\r"), false);
  assert.strictEqual(res["next step"].includes("\r"), false);
});

// KNOWN FAILURE (src/worker.js parseNow):
// Even without a trailing CRLF, any line ending in "\r" before "\n" is dropped.
test("parseNow: Windows CRLF without trailing newline keeps all lines without \\r [KNOWN FAILURE]", () => {
  const res = parseNow("Doing: redesign\r\nNext step: ship");
  assert.deepStrictEqual(res, { doing: "redesign", "next step": "ship" });
  assert.strictEqual(res.doing.includes("\r"), false);
});

test('parseNow: line like "Doing:" with no value is ignored', () => {
  assert.deepStrictEqual(parseNow("Doing:\nNext step: ship"), { "next step": "ship" });
  assert.deepStrictEqual(parseNow("Doing:"), {});
});

// KNOWN FAILURE (src/worker.js parseNow):
// In /^\s*(...)\s*:\s*(.+)$/i, `\s*` backtracks over trailing spaces so `(.+)`
// captures a space and `.trim()` produces "", storing { doing: "" } instead of
// ignoring a whitespace-only value.
test('parseNow: line like "Doing:   " with whitespace-only value is ignored [KNOWN FAILURE]', () => {
  assert.deepStrictEqual(parseNow("Doing:   \nNext step: ship"), { "next step": "ship" });
});

test("parseNow: unknown keys are ignored", () => {
  assert.deepStrictEqual(parseNow("Author: Martin\nPriority: high\nDoing: testing"), { doing: "testing" });
  assert.deepStrictEqual(parseNow("Foo: bar\nBaz: qux"), {});
});

// --- laneFor boundaries -----------------------------------------------------
test('laneFor: NOW.md repo pushed exactly 14 days ago = "progress", 15 days = "paused"', () => {
  assert.strictEqual(laneFor(repo({ now: { text: NOW }, pushedAt: d(14) }), now), "progress");
  assert.strictEqual(laneFor(repo({ now: { text: NOW }, pushedAt: d(15) }), now), "paused");
});

test('laneFor: no-NOW repo pushed 30 days ago = "nobookmark", 31 days = "dusty"', () => {
  assert.strictEqual(laneFor(repo({ now: null, pushedAt: d(30) }), now), "nobookmark");
  assert.strictEqual(laneFor(repo({ now: null, pushedAt: d(31) }), now), "dusty");
});

test('laneFor: archived repo with a fresh PR is still "graveyard"', () => {
  assert.strictEqual(laneFor(repo({ isArchived: true, pullRequests: pr(0) }), now), "graveyard");
  assert.strictEqual(laneFor(repo({ isArchived: true, pullRequests: pr(1) }), now), "graveyard");
});

// --- renderBoard escaping ---------------------------------------------------
test("renderBoard: escapes <script>alert(1)</script> in repo name and NOW.md Doing value", () => {
  const xss = "<script>alert(1)</script>";
  const escaped = "&lt;script&gt;alert(1)&lt;/script&gt;";
  const html = renderBoard([
    repo({ name: `repo-${xss}`, now: { text: `Doing: doing-${xss}` } }),
  ], now);
  assert(html.includes(`repo-${escaped}`), "repo name must appear escaped");
  assert(html.includes(`doing-${escaped}`), "NOW.md Doing value must appear escaped");
  assert(!html.includes(xss), "raw <script>alert(1)</script> must never appear");
  assert(!html.includes("<script>"), "raw <script> tag must never appear");
});

// --- buildBoard deploysAvailable --------------------------------------------
test("buildBoard: deploysAvailable is false when deploys is undefined, true when an array", () => {
  const r = repo({ name: "x", now: { text: NOW } });
  assert.strictEqual(buildBoard([r], now).deploysAvailable, false);
  assert.strictEqual(buildBoard([r], now, undefined).deploysAvailable, false);
  assert.strictEqual(buildBoard([r], now, []).deploysAvailable, true);
  assert.strictEqual(
    buildBoard([r], now, [{ kind: "Worker", project: "x", repo: "x", git: true, lastDeploy: d(0), trigger: null }]).deploysAvailable,
    true,
  );
});

if (failures.length) {
  console.error(`\nedges tests: ${failures.length} failed (${failures.map((f) => f.name).join("; ")})`);
  process.exit(1);
}
console.log("edges tests passed");
