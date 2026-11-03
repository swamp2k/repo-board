import { parseNow, laneFor, renderBoard, promptsFor } from "../src/worker.js";
import assert from "node:assert";
import { handleT3Request, parseRepositories } from "../src/t3.js";

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
const safePrompt = promptsFor(repo({ name: "safe", url: "https://github.com/swamp2k/safe" }), { safeInspection: true }).prompt;
assert.match(safePrompt, /read-only mode/);
assert.match(safePrompt, /Do not edit files/);
assert.match(promptsFor(repo({ name: "safe", url: "u" })).prompt, /If neither exists, create both/);
console.log("all tests passed");

// T3 API stays disabled by default, authenticates every mock request, checks
// browser write origin/header, and isolates persistent sessions by GitHub ID.
{
  const rows = new Map();
  const store = { async get(k, type) { const v = rows.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }, async put(k, v) { rows.set(k, v); } };
  const allowlist = [
    { githubId: 10, owner: "swamp2k", repo: "old-name", projectId: "p1", workspace: "w1", verified: true },
    { githubId: 20, owner: "swamp2k", repo: "another", projectId: "p2", workspace: "w2", verified: true },
  ];
  const env = { T3_MODE: "mock", T3_API_TOKEN: "server-secret", T3_STORE: store, T3_REPOSITORIES: JSON.stringify(allowlist) };
  const req = (path, method = "GET", body, extra = {}) => new Request(`https://board.example/api/t3/${path}`, {
    method, headers: { authorization: `Basic ${btoa("demo:server-secret")}`, ...(method === "GET" ? {} : { origin: "https://board.example", "x-t3-request": "1", "content-type": "application/json" }), ...extra },
    body: body == null ? undefined : JSON.stringify(body),
  });
  assert.equal((await handleT3Request(req("10"), { ...env, T3_MODE: "live" })).status, 503);
  assert.equal((await handleT3Request(req("10", "GET", null, { authorization: "Bearer wrong" }), env)).status, 401);
  assert.equal((await handleT3Request(req("/etc/passwd"), env)).status, 404);
  assert.throws(() => parseRepositories([{ ...allowlist[0], verified: false }]), /invalid_repository_configuration/);
  assert.equal((await handleT3Request(req("10", "POST", { requestId: "test-request-1", prompt: "Read NOW.md and inspect status." }, { origin: "https://evil.example" }), env)).status, 403);
  assert.equal((await handleT3Request(req("10", "POST", { requestId: "test-request-1", prompt: "Read NOW.md." }, { "x-t3-request": "" }), env)).status, 403);
  const created = await handleT3Request(req("10", "POST", { requestId: "test-request-1", prompt: "Inspect repository read-only." }), env);
  assert.equal(created.status, 201);
  const session = (await created.json()).session;
  assert(session.id.startsWith("mock-"));
  assert.match(session.messages[1].content, /SIMULATED/);
  const listed = await (await handleT3Request(req("10"), env)).json();
  assert.equal(listed.sessions[0].id, session.id);
  assert.equal(listed.repository.name, "swamp2k/old-name");
  const renamed = [{ ...allowlist[0], repo: "new-name" }, allowlist[1]];
  const afterRename = await (await handleT3Request(req("10"), { ...env, T3_REPOSITORIES: JSON.stringify(renamed) })).json();
  assert.equal(afterRename.repository.name, "swamp2k/new-name");
  assert.equal(afterRename.sessions[0].id, session.id);
  assert.equal((await handleT3Request(req("20"), env)).status, 200);
  assert.equal((await (await handleT3Request(req("20"), env)).json()).sessions.length, 0);
  assert.equal((await handleT3Request(req(`10/${session.id}/messages`, "POST", { text: "Continue safely" }), env)).status, 200);
  assert.equal((await handleT3Request(req(`10/${session.id}/stop`, "POST", {}), env)).status, 200);
  assert.equal((await handleT3Request(req(`10/${session.id}/messages`, "POST", { text: "Again" }), env)).status, 409);
  assert.equal((await handleT3Request(req("10", "POST", { requestId: "test-request-2", prompt: "Read NOW.md", workspace: "/etc/passwd" }), env)).status, 400);
  const retry = await (await handleT3Request(req("10", "POST", { requestId: "test-request-1", prompt: "Inspect repository read-only." }), env)).json();
  assert.equal(retry.session.id, session.id, "retry must reuse session");
  assert.equal((await (await handleT3Request(req("10"), env)).json()).sessions.length, 1);
  assert.equal((await handleT3Request(req(`20/${session.id}/messages`, "POST", { text: "wrong repo" }), env)).status, 404);
  assert.equal((await handleT3Request(req("10/missing/messages", "POST", { text: "stale thread" }), env)).status, 404);
  assert.equal((await handleT3Request(req("10"), { ...env, T3_STORE: null })).status, 503);
  const offlineStore = { get() { throw Error("sensitive upstream detail"); }, put() {} };
  const unavailable = await handleT3Request(req("10"), { ...env, T3_STORE: offlineStore });
  assert.equal(unavailable.status, 503);
  assert(!JSON.stringify(await unavailable.json()).includes("sensitive"));
  assert.throws(() => parseRepositories([allowlist[0], { ...allowlist[0], githubId: 99 }]), /invalid_repository_configuration/);
  const tooLarge = await handleT3Request(req("10", "POST", { requestId: "test-request-big", prompt: "x".repeat(13000) }), env);
  assert.equal(tooLarge.status, 400);
  assert.equal((await handleT3Request(req("10", "POST", { requestId: "test-request-3", prompt: "inspect" }, { origin: "" }), env)).status, 403);
    console.log("T3 mock security and persistence ok");
}

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

// Worker wiring: mock card mappings use GitHub ID + canonical name, never a name
// collision, and mock HTML cannot reuse the default board cache.
{
  const { default: worker } = await import('../src/worker.js');
  const savedFetch = globalThis.fetch;
  const savedCaches = globalThis.caches;
  let cacheReads = 0, cacheWrites = 0;
  globalThis.caches = { default: { async match() { cacheReads++; }, async put() { cacheWrites++; } } };
  const pilot = repo({ databaseId: 10, name: 'demo', nameWithOwner: 'other/demo', url: 'https://github.com/other/demo' });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { user: { repositories: { nodes: [pilot] } } } }));
  const mapping = { githubId: 10, owner: 'other', repo: 'demo', projectId: 'mock-demo', workspace: 'mock-only', verified: true };
  const env = { GITHUB_TOKEN: 'test-only', T3_MODE: 'mock', T3_REPOSITORIES: JSON.stringify([mapping]) };
  try {
    const rendered = await worker.fetch(new Request('https://board.example/'), env, { waitUntil() {} });
    const content = await rendered.text();
    assert.match(content, /data-t3-repo="10"/);
    assert.match(content, /Inspect other\/demo/);
    assert.match(content, /MOCK DEMO/);
    assert(!content.includes('test-only'));
    assert.equal(cacheReads, 0); assert.equal(cacheWrites, 0);
    const mismatch = await worker.fetch(new Request('https://board.example/'), { ...env, T3_REPOSITORIES: JSON.stringify([{ ...mapping, owner: 'wrong' }]) }, { waitUntil() {} });
    assert.match(await mismatch.text(), /"repositories":\[\]/);
    const apiDisabled = await worker.fetch(new Request('https://board.example/api/t3/10'), {}, {});
    assert.equal(apiDisabled.status, 503);
  } finally { globalThis.fetch = savedFetch; globalThis.caches = savedCaches; }
  console.log('Worker T3 routing, cache separation and canonical identity ok');
}
