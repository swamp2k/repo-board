import { parseNow, laneFor, renderBoard } from "../src/worker.js";
import assert from "node:assert";

const now = Date.parse("2026-10-31T14:00:00Z");
const d = (n) => new Date(now - n * 86400000).toISOString();
const NOW = `Doing: redesign
Next step: review PR #47
Updated: 2026-10-31`;
const noPr = { totalCount: 0, nodes: [] };
const pr = (days) => ({ totalCount: 1, nodes: [{ number: 47, title: "Scroll", url: "p", updatedAt: d(days) }] });
const repo = (o) => ({ name: "r", url: "u", pushedAt: d(0), isPrivate: false, isArchived: false, now: null, pullRequests: noPr, ...o });

assert.equal(parseNow("Epitaph: fun, done")["epitaph"], "fun, done");
assert.equal(laneFor(repo({ pullRequests: pr(3) }), now), "review");
assert.equal(laneFor(repo({ pullRequests: pr(14) }), now), "review");
assert.equal(laneFor(repo({ pullRequests: pr(15) }), now), "decide");
assert.equal(laneFor(repo({ pullRequests: pr(89), isArchived: true }), now), "graveyard");
assert.equal(laneFor(repo({ now: { text: NOW } }), now), "progress");
assert.equal(laneFor(repo({ now: { text: NOW }, pushedAt: d(20) }), now), "paused");
assert.equal(laneFor(repo({}), now), "nobookmark");
assert.equal(laneFor(repo({ pushedAt: d(40) }), now), "dusty");

const html = renderBoard([
  repo({ name: "noteflow-v2", pullRequests: pr(89) }),
  repo({ name: "dugg", isArchived: true, now: { text: "Epitaph: kids loved it, done" } }),
  repo({ name: "glb", now: { text: NOW } }),
], now);
assert(html.includes("1 open PR: decide before retiring"));
assert(html.includes("kids loved it, done"));
assert(html.includes("ask me what to do with each"));
assert(html.indexOf("Decide") < html.indexOf("Waiting for review"));
console.log("all tests passed");

// buildBoard gives Nexus the same lanes as the web page
{
  const { buildBoard } = await import("../src/worker.js");
  const now = Date.now();
  const repo = { name: "x", url: "u", isPrivate: false, isArchived: false, pushedAt: new Date(now).toISOString(), now: { text: "Doing: a\nNext step: b" }, pullRequests: { totalCount: 0, nodes: [] } };
  const board = buildBoard([repo], now);
  const lane = board.lanes.find((l) => l.id === "progress");
  if (board.contractVersion !== 1 || lane.repos[0].nextStep !== "b" || !lane.repos[0].resumePrompt) throw new Error("buildBoard failed");
  console.log("buildBoard ok");
}
