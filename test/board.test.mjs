import web, { parseNow, laneFor, renderBoard, page, promptsFor, buildBoard, t3InspectionPrompt } from "../src/worker.js";
import assert from "node:assert";
import { canonicalRepo, resolveProject, verifyAccess, handleT3Request } from "../src/t3.js";
import { createT3Client } from "../src/t3-client.js";
import { handleT3AuthRequest, liveRead, liveSend, T3AuthStore } from "../src/t3-live.js";
import { runInNewContext } from "node:vm";

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

// Exercise the real Worker fetch path: live mode must reach the page unchanged,
// and cached pages must be isolated by mode.
{
  const oldFetch = globalThis.fetch, oldCaches = globalThis.caches;
  const entries = new Map(); let githubCalls = 0;
  globalThis.caches = { default: { match: async (key) => entries.get(key.url)?.clone(), put: async (key, value) => entries.set(key.url, value.clone()) } };
  globalThis.fetch = async () => { githubCalls++; return Response.json({ data: { user: { repositories: { nodes: [{ id: "R_kgDOUSfguQ", name: "glb-viewer", url: "https://github.com/swamp2k/glb-viewer", pushedAt: new Date().toISOString(), isPrivate: false, isArchived: false, owner: { login: "swamp2k" }, now: null, pullRequests: { totalCount: 0, nodes: [] } }] } } } }); };
  try {
    const respond = (mode, refresh = "") => web.fetch(new Request(`https://board.example/${refresh}`), { T3_MODE: mode, GITHUB_TOKEN: "test" }, { waitUntil: (p) => p });
    const live = await respond("live"); assert((await live.text()).includes("T3 conversations"));
    const mock = await respond("mock"); assert((await mock.text()).includes("Run in T3"));
    const disabled = await respond("garbage"); const disabledHtml = await disabled.text();
    assert(!disabledHtml.includes("data-t3-repo=") && !disabledHtml.includes('id="t3-panel"'));
    assert.equal(githubCalls, 3, "live, mock and disabled use distinct cache entries");
    const disabledAgain = await respond("off"); assert(!(await disabledAgain.text()).includes("data-t3-repo="));
    assert.equal(githubCalls, 3, "unrecognized disabled modes share the disabled cache entry");
  } finally { globalThis.fetch = oldFetch; globalThis.caches = oldCaches; }
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

// Stable GitHub IDs survive name changes and avoid owner/name collisions.
{
  const mockEnv = { T3_MODE: "mock" };
  const before = { id: "R_123", owner: { login: "alice" }, name: "widget", url: "https://github.com/alice/widget" };
  const renamed = { ...before, owner: { login: "alice-new" }, name: "widget-next", url: "https://github.com/alice-new/widget-next" };
  const a = resolveProject(before, mockEnv), b = resolveProject(renamed, mockEnv);
  assert.equal(a.projectId, b.projectId);
  assert.equal(a.workspaceRoot, "/mock/alice/widget");
  assert.equal(b.fullName, "alice-new/widget-next");
  const mappedLive = resolveProject(before, { T3_MODE: "live", T3_PROJECTS_JSON: JSON.stringify([{ repoId: "R_123", owner: "alice", name: "widget", projectId: "p", workspaceRoot: "/work/widget" }]) });
  assert.equal(mappedLive.workspaceRoot, "/work/widget");
  const sameNameOtherOwner = canonicalRepo({ id: "legacy/Rg==", owner: { login: "bob" }, name: "widget", url: "https://github.com/bob/widget" });
  assert.notEqual(sameNameOtherOwner.id, a.id);
  assert.throws(() => resolveProject({ ...before, owner: { login: "alice-new" }, url: "https://github.com/alice-new/widget" }, { T3_MODE: "live", T3_PROJECTS_JSON: JSON.stringify([{ repoId: "R_123", owner: "alice", name: "widget", projectId: "p", workspaceRoot: "/work/alice/widget" }]) }), /mapping does not match/);
  assert.throws(() => resolveProject(before, { T3_MODE: "live", T3_PROJECTS_JSON: JSON.stringify([{ repoId: "R_123", owner: "alice", name: "widget", projectId: "p", workspaceRoot: "/work/widget" }, { repoId: "R_123", owner: "alice", name: "widget", projectId: "p2", workspaceRoot: "/work/widget2" }]) }), /No unique/);
  assert.throws(() => resolveProject(before, { T3_MODE: "live", T3_PROJECTS_JSON: JSON.stringify([{ repoId: "R_123", owner: "alice", name: "widget", projectId: "p", workspaceRoot: "/work/../other" }]) }), /mapping does not match/);
  assert.throws(() => resolveProject(before, { T3_MODE: "live", T3_PROJECTS_JSON: JSON.stringify([{ repoId: "R_123", owner: "alice", name: "widget", projectId: "same", workspaceRoot: "/work/one" }, { repoId: "R_456", owner: "bob", name: "widget", projectId: "same", workspaceRoot: "/work/two" }]) }), /mapped to more than one repository/);
  assert.throws(() => resolveProject(before, { T3_MODE: "live", T3_PROJECTS_JSON: "{}" }), /mappings are unavailable/);
  console.log("identity and mapping checks ok");
}

// Signed Access tokens are verified against issuer, audience, expiry, key and allowlist.
{
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = "test-key"; jwk.use = "sig";
  const domain = "https://team.cloudflareaccess.com";
  const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
  const sign = async (claims) => {
    const h = b64({ alg: "RS256", kid: jwk.kid, typ: "JWT" }), p = b64(claims);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
  };
  const env = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "board-aud", ACCESS_ALLOWED_EMAILS: "owner@example.com" };
  const fetcher = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  const claims = { iss: domain, aud: ["board-aud"], sub: "subject-1", email: "OWNER@example.com", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+120 };
  const valid = new Request("https://board.example/api/t3", { headers: { "cf-access-jwt-assertion": await sign(claims) } });
  assert.equal((await verifyAccess(valid, env, fetcher)).sub, "subject-1");
  const badAud = await sign({ ...claims, aud: "wrong" });
  const expired = await sign({ ...claims, exp: 1 });
  const missingSub = await sign({ ...claims, sub: undefined });
  const missingIat = await sign({ ...claims, iat: undefined });
  const missingIssuer = await sign({ ...claims, iss: undefined });
  const invalidSignature = `${(await sign(claims)).split(".").slice(0, 2).join(".")}.${b64("not a signature")}`;
  const extraSegment = `${await sign(claims)}.extra`;
  const unauthorizedIdentity = await sign({ ...claims, email: "intruder@example.com", sub: "unapproved" });
  await assert.rejects(() => verifyAccess(new Request(valid.url, { headers: { "cf-access-jwt-assertion": badAud } }), env, fetcher), /valid Cloudflare Access/);
  await assert.rejects(() => verifyAccess(new Request(valid.url, { headers: { "cf-access-jwt-assertion": expired } }), env, fetcher), /valid Cloudflare Access/);
  await assert.rejects(() => verifyAccess(new Request(valid.url, { headers: { "cf-access-jwt-assertion": missingSub } }), env, fetcher), /valid Cloudflare Access/);
  await assert.rejects(() => verifyAccess(new Request(valid.url, { headers: { "cf-access-jwt-assertion": missingIat } }), env, fetcher), /valid Cloudflare Access/);
  await assert.rejects(() => verifyAccess(new Request(valid.url, { headers: { "cf-access-jwt-assertion": missingIssuer } }), env, fetcher), /valid Cloudflare Access/);
  await assert.rejects(() => verifyAccess(new Request(valid.url, { headers: { "cf-access-jwt-assertion": extraSegment } }), env, fetcher), /valid Cloudflare Access/);
  await assert.rejects(() => verifyAccess(new Request(valid.url, { headers: { "cf-access-jwt-assertion": invalidSignature } }), env, fetcher), /valid Cloudflare Access/);
  await assert.rejects(() => verifyAccess(new Request(valid.url, { headers: { "cf-access-jwt-assertion": unauthorizedIdentity } }), env, fetcher), /valid Cloudflare Access/);
  await assert.rejects(() => verifyAccess(valid, {}, fetcher), /not configured/);
  console.log("Access JWT checks ok");
}

// Every API read/write authenticates; same-origin and custom write header are enforced.
{
  const repoA = { id: "legacy/Rg==", owner: { login: "alice" }, name: "widget", url: "https://github.com/alice/widget" };
  const repoB = { id: "R_new_456-x", owner: { login: "bob" }, name: "widget", url: "https://github.com/bob/widget" };
  const env = { T3_MODE: "mock" };
  const findRepo = async (id) => ({ [repoA.id]: repoA, [repoB.id]: repoB }[id] || null);
  const authenticate = async (_r, _env) => ({ sub: "test-user" });
  const call = (repoId, body, headers = {}) => handleT3Request(new Request(`https://board.example/api/t3?repoId=${repoId}`, { method: "POST", headers: { origin: "https://board.example", "content-type": "application/json", "x-repo-board-request": "1", ...headers }, body: JSON.stringify(body) }), env, { authenticate, findRepo });
  const missingAuth = await handleT3Request(new Request("https://board.example/api/t3?repoId=R_123", { method: "POST", headers: { origin: "https://board.example" }, body: "{}" }), env, { findRepo });
  assert.equal(missingAuth.status, 503);
  const unauthorizedRead = await handleT3Request(new Request("https://board.example/api/t3?repoId=R_123", { method: "GET", headers: { origin: "https://board.example" } }), { ...env, ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com", ACCESS_AUD: "aud", ACCESS_ALLOWED_SUBJECTS: "approved" }, { findRepo });
  assert.equal(unauthorizedRead.status, 401);
  assert.equal((await (await call(repoA.id, { action: "list" })).json()).mock, true);
  assert.equal((await call(repoA.id, { action: "list" }, { "x-repo-board-request": "" })).status, 403);
  assert.equal((await call(repoA.id, { action: "list" }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await call(repoA.id, { action: "list" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(repoA.id, { action: "list" }, { origin: "https://board.example", host: "evil.example" })).status, 200);
  assert.equal((await call("bad!id", { action: "list" })).status, 400);
  const requestId = "12345678-1234-1234-1234-123456789abc";
  const prompt = t3InspectionPrompt(repoA);
  const createBody = { action: "new", requestId, prompt };
  const first = await (await call(repoA.id, createBody)).json();
  const retry = await (await call(repoA.id, createBody)).json();
  assert.equal(first.thread.id, retry.thread.id, "retrying create must return the same thread identity");
  assert.equal(first.thread.messages[0].text, prompt);
  assert.equal(first.thread.status, "waiting");
  assert(first.mock && first.thread.messages[1].text.includes("No agent was launched"));
  assert.equal((await call(repoA.id, { action: "send", threadId: first.thread.id, text: "follow up" })).status, 200);
  assert.equal((await call(repoA.id, { action: "resume", threadId: first.thread.id })).status, 200);
  assert.equal((await call(repoA.id, { action: "cancel", threadId: first.thread.id })).status, 200);
  assert.equal((await call(repoA.id, { action: "send", threadId: first.thread.id.replace(repoA.id, repoB.id), text: "cross repo" })).status, 404);
  assert.equal((await call(repoB.id, { action: "resume", threadId: first.thread.id })).status, 404);
  assert.equal((await call(repoA.id, { action: "resume", threadId: first.thread.id.replace(repoA.id, repoA.id + "-abcd") })).status, 404, "repository IDs with a shared prefix must remain isolated");
  assert.equal((await call(repoA.id, { action: "new", requestId, prompt }, { "x-repo-board-request": "" })).status, 403);
  const noOriginRead = await handleT3Request(new Request(`https://board.example/api/t3?repoId=${encodeURIComponent(repoA.id)}`, { method: "GET" }), env, { authenticate, findRepo });
  assert.equal(noOriginRead.status, 200);
  const tooLarge = await call(repoA.id, { action: "new", requestId, prompt: "x".repeat(9_000) });
  assert.equal(tooLarge.status, 413);
  const invalidJson = await handleT3Request(new Request(`https://board.example/api/t3?repoId=${encodeURIComponent(repoA.id)}`, { method: "POST", headers: { origin: "https://board.example", "x-repo-board-request": "1", "content-type": "application/json" }, body: "{" }), env, { authenticate, findRepo });
  assert.equal(invalidJson.status, 400);
  console.log("authorization, CSRF, filtering, reload-id and mock thread checks ok");
}

// The same client used by the panel keeps state by opaque repo ID and ignores stale views.
{
  class Storage {
    values = new Map();
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, value); }
  }
  const storage = new Storage();
  const deferred = [];
  const deferredOperations = [];
  let failNext = false;
  const transport = (repoId, body) => {
    if (failNext) { failNext = false; return Promise.reject(new Error("offline")); }
    if (body.action === "list" && repoId === "repo-A") return new Promise((resolve) => deferred.push(() => resolve({ mock: true, project: { workspaceRoot: "/mock/A" }, conversations: [] })));
    if (body.action === "resume" && repoId === "repo-A") return new Promise((resolve) => deferredOperations.push(() => resolve({ mock: true, thread: { id: body.threadId, status: "running", updatedAt: new Date().toISOString(), message: "Mock running" } })));
    const thread = { id: `mock-${repoId}-${body.requestId || "one"}`, title: "Inspection", status: body.action === "cancel" ? "cancelled" : "waiting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [{ role: "user", text: body.prompt || "" }] };
    return Promise.resolve({ mock: true, thread, project: { workspaceRoot: `/mock/${repoId}` } });
  };
  const Client = createT3Client();
  const client = new Client({ storage, transport });
  client.select("repo-A");
  const stale = client.list();
  client.select("repo-B");
  deferred.shift()();
  assert.equal((await stale).stale, true, "late repo A view must not replace repo B view");
  client.select("repo-A");
  await client.create("repo A inspection", "request-A");
  const delayedOperation = client.operation("resume");
  client.select("repo-B");
  deferredOperations.shift()();
  assert.equal((await delayedOperation).stale, true, "late operation must not render in repo B");
  assert.equal(client.read("repo-A").conversations[0].status, "running", "late operation still saves to its captured repo A");
  assert.equal(client.read("repo-B").conversations.length, 0, "repo A conversation must not leak into repo B");
  await client.create("inspect repository", "request-a");
  const aState = client.read("repo-B");
  await client.create("inspect repository", "request-a");
  assert.equal(client.read("repo-B").conversations.length, 1, "replaying a create request is idempotent in the client store");
  assert.equal(aState.selectedId, aState.conversations[0].id);
  assert.equal(aState.conversations[0].status, "waiting");
  client.advance();
  assert.equal(client.read("repo-B").conversations[0].status, "running");
  client.advance();
  assert.equal(client.read("repo-B").conversations[0].status, "completed");
  await client.followup("next question");
  assert(aState.conversations[0].messages.length === 1, "writes update persisted snapshot, not old object references");
  const followed = client.read("repo-B");
  assert.equal(followed.conversations[0].messages.at(-2).role, "user");
  const ReloadedClient = new Client({ storage, transport });
  ReloadedClient.select("repo-B");
  const restored = await ReloadedClient.list();
  assert.equal(restored.selectedId, followed.selectedId, "selection must restore by repository after switching");
  assert(restored.conversations[0].messages.some((message) => message.text === "next question"));
  failNext = true;
  await assert.rejects(() => client.operation("resume"), /offline/);
  assert.equal(client.connection, "disconnected");
  assert.equal(client.read("repo-B").conversations[0].status, "failed");
  await client.retry();
  assert.equal(client.connection, "mock", "retry reconnects the mock adapter");
  client.select("no-selection");
  await assert.rejects(() => client.followup("missing selection"), /Select a conversation/);
  client.select("corrupt");
  storage.setItem("repo-board-t3-mock:corrupt", "{");
  assert.deepEqual(client.read(), { conversations: [], selectedId: null, activity: [] });
  storage.setItem("repo-board-t3-mock:corrupt", JSON.stringify({ conversations: [null, {}, { id: "survivor", messages: [{ text: "kept" }] }], selectedId: "missing" }));
  assert.equal(client.read().selectedId, "survivor", "valid JSON with damaged entries recovers a usable selection");
  storage.setItem("repo-board-t3-mock:legacy", JSON.stringify([{ id: "legacy-thread", createdAt: new Date().toISOString(), messages: [{ text: "legacy message" }] }]));
  storage.setItem("repo-board-t3-mock:legacy:activity", JSON.stringify([{ at: new Date().toISOString(), text: "old activity" }]));
  assert.equal(client.read("legacy").conversations[0].id, "legacy-thread", "prior array storage format is migrated");
  assert.equal(client.read("legacy").activity[0].text, "old activity");
  let finishOldRequest;
  const racing = new Client({ storage, transport: (repoId) => repoId === "old"
    ? new Promise((resolve) => { finishOldRequest = resolve; })
    : Promise.reject(new Error("current repository is offline")) });
  racing.select("old");
  const oldRequest = racing.list();
  racing.select("current");
  await assert.rejects(() => racing.list(), /current repository is offline/);
  const currentError = racing.error;
  finishOldRequest({ mock: true });
  assert.equal((await oldRequest).stale, true);
  assert.equal(racing.error, currentError, "stale success must not clear the current repository error");
  assert.equal(racing.connection, "disconnected");
  console.log("adapter isolation, selection, follow-up, retry, and storage recovery ok");
}

// Live mode and disabled mode stay fail closed; existing board and prompt contract remain.
{
  const repo = { id: "R_123", owner: { login: "alice" }, name: "widget", url: "https://github.com/alice/widget", pushedAt: d(0), isPrivate: false, isArchived: false, now: { text: NOW }, pullRequests: noPr };
  const legacy = promptsFor(repo);
  const oldPrefix = `Open swamp2k/widget (${repo.url}). Read AGENTS.md, CLAUDE.md and HANDOVER.md where present. First check the repository root for AGENTS.md and CLAUDE.md (exact uppercase filenames). If neither exists, create both with identical contents. If only one exists, copy its full contents to the other filename. If both exist and differ, explain the differences and propose a merged version preserving useful instructions; wait for my choice before changing either file or continuing implementation. If they are identical, keep them aligned. Preserve existing instructions and include these rules identically in both: read NOW.md at session start, update it before ending every session, and whenever either root instruction file changes, update both identically. Leave nested instruction files unchanged. `;
  assert.equal(legacy.prompt, oldPrefix + 'Read NOW.md and continue from "Next step". Update NOW.md before ending the session.');
  assert.equal(promptsFor({ ...repo, now: null }).prompt, oldPrefix + 'Inspect the README, code, recent commits and open pull requests. Summarise the current state and suggest the next concrete action. Check whether NOW.md already exists in the repository root; read and update it if present, preserving relevant content, and create it only if missing. Use these fields: Doing, State, Next step, Blocked by, Updated (YYYY-MM-DD). Base it on verified findings; mark anything uncertain. Keep NOW.md current as work progresses. Commit and push the bookmark and instruction changes following the repository workflow (use a branch and PR if required), so they are available on GitHub. Present your findings and proposed next action, then wait for my direction before implementing further changes.');
  assert(legacy.prompt.includes("create both with identical contents"));
  assert(legacy.prompt.includes('continue from "Next step"'));
  assert(promptsFor({ ...repo, now: null }).prompt.includes("Commit and push the bookmark and instruction changes"));
  assert(t3InspectionPrompt(repo).includes("read-only pilot") && t3InspectionPrompt(repo).includes("do not modify files"));
  const v1 = buildBoard([repo], now).lanes.flatMap((x) => x.repos)[0];
  assert.deepEqual(Object.keys(v1), ["name", "url", "isPrivate", "daysSincePush", "doing", "state", "nextStep", "blockedBy", "epitaph", "hasNow", "openPrs", "prs", "resumePrompt", "retirePrompt"]);
  const html = page(renderBoard([repo], now, true), true);
  assert(html.includes("Run in T3") && html.includes("<dialog") && html.includes("aria-labelledby"));
  assert(html.includes("New mock conversation") && html.includes("Retry connection") && html.includes("localStorage"));
  assert(html.includes("Connection:") && html.includes("flex-wrap:wrap") && !html.includes('e.target===panel'));
  assert(html.includes("@media (max-width:700px)"));
  assert.doesNotThrow(() => new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]), "rendered panel script must parse");
  const noT3 = page(renderBoard([repo], now), false);
  assert(!noT3.includes("data-t3-repo"));
  const liveHtml = page(renderBoard([{ ...repo, owner: { login: "swamp2k" }, name: "glb-viewer" }], now, "live"), "live");
  assert(liveHtml.includes("T3 conversations") && liveHtml.includes("Connect to T3") && liveHtml.includes("Disconnect"));
  assert(!liveHtml.includes("New mock conversation") && !liveHtml.includes("Send mock follow-up") && !liveHtml.includes("Mock resume"));
  assert.doesNotThrow(() => new Function(liveHtml.match(/<script>([\s\S]*?)<\/script>/)[1]), "rendered live panel script must parse");
  const authenticate = async () => ({ sub: "test" });
  const request = () => new Request("https://board.example/api/t3?repoId=R_123", { method: "POST", headers: { origin: "https://board.example", "x-repo-board-request": "1", "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) });
  const mapping = JSON.stringify([{ repoId: "R_123", owner: "alice", name: "widget", projectId: "verified-project", workspaceRoot: "/work/alice/widget" }]);
  const res = await handleT3Request(request(), { T3_MODE: "live", BOARD_ORIGIN: "https://board.example", T3_PROJECTS_JSON: mapping, T3_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { authenticate, findRepo: async () => repo });
  assert.equal(res.status, 405);
  assert((await res.text()).includes("read only"));
  const off = await handleT3Request(request(), {}, { authenticate, findRepo: async () => repo });
  assert.equal(off.status, 503);
  console.log("UI, prompt regression and fail-closed modes ok");
}

// Run the live panel script against a small DOM and deferred transport so stale
// selection responses cannot replace the newest conversation.
{
  class Element {
    constructor(id = "") { this.id = id; this.children = []; this.dataset = {}; this.hidden = false; this.listeners = {}; this.textContent = ""; this.open = false; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
  }
  const elements = new Map(), documentListeners = {};
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); },
    createElement() { return new Element(); },
    createTextNode(text) { const node = new Element(); node.textContent = text; return node; },
    addEventListener(name, callback) { (documentListeners[name] ||= []).push(callback); },
    querySelector() { return null; },
  };
  const card = new Element("glb-viewer");
  card.dataset = { t3Repo: "R_kgDOUSfguQ", t3Name: "swamp2k/glb-viewer", t3Url: "https://github.com/swamp2k/glb-viewer", t3Now: "No NOW.md status available", t3HasNow: "no" };
  const pending = new Map();
  const requestedUrls = [];
  let expired = false;
  const conversations = [{ id: "thread-one", title: "One" }, { id: "thread-two", title: "Two" }];
  const fetch = async (url) => {
    requestedUrls.push(url);
    if (url === "/api/t3/auth/session") return Response.json({ connected: true, csrf: "csrf-token" });
    if (url === "/api/t3/auth/disconnect") return Response.json({ connected: false });
    if (expired) return Response.json({ error: { code: "t3_session_expired", message: "T3 sign-in expired" } }, { status: 401 });
    const threadId = new URL(url, "https://board.example").searchParams.get("threadId");
    if (!threadId) return Response.json({ mode: "live-read-only", project: { workspaceRoot: "/projects/glb-viewer" }, conversations, selected: null, hasMore: false });
    return new Promise((resolve) => pending.set(threadId, resolve));
  };
  const html = page(renderBoard([{ id: "R_kgDOUSfguQ", owner: { login: "swamp2k" }, name: "glb-viewer", url: card.dataset.t3Url, now: null, pushedAt: new Date().toISOString(), pullRequests: noPr }], Date.now(), "live"), "live");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const storage = new Map();
  runInNewContext(script, { document, fetch, localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, location: { search: "", pathname: "/", hash: "", assign() {} }, history: { replaceState() {} }, CSS: { escape: (s) => s }, URLSearchParams, AbortController, Response, setInterval: () => 1, clearInterval() {} });
  const fireCardClick = () => documentListeners.click.forEach((handler) => handler({ target: { closest: (selector) => selector === "[data-t3-repo]" ? card : null } }));
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(setImmediate); };
  fireCardClick(); await flush();
  const list = document.getElementById("t3-list");
  assert.equal(list.children.length, 2, `live list did not render (panel=${document.getElementById("t3-panel").open}, status=${document.getElementById("t3-status").textContent}, error=${document.getElementById("t3-error").textContent}, urls=${requestedUrls})`);
  list.children[0].children[0].onclick(); await flush();
  list.children[1].children[0].onclick(); await flush();
  const reply = (id, text) => Response.json({ mode: "live-read-only", project: { workspaceRoot: "/projects/glb-viewer" }, conversations, selected: { id, items: [{ createdBy: "agent", type: "assistant_message", text, textTruncated: false }], hasMore: false }, hasMore: false });
  pending.get("thread-one")(reply("thread-one", "STALE RESPONSE")); await flush();
  pending.get("thread-two")(reply("thread-two", "LATEST RESPONSE")); await flush();
  const visible = JSON.stringify(list.children, (key, value) => ["onclick", "listeners"].includes(key) ? undefined : value);
  assert(visible.includes("LATEST RESPONSE"));
  assert(!visible.includes("STALE RESPONSE"), "a slower older selection cannot overwrite the newest selection");
  list.children[0].children[0].onclick(); await flush();
  await document.getElementById("t3-disconnect").onclick(); await flush();
  pending.get("thread-one")(reply("thread-one", "AFTER DISCONNECT")); await flush();
  assert.equal(list.children.length, 0, "a stale read cannot repopulate messages after disconnect");
  assert.equal(document.getElementById("t3-status").textContent, "Connection: disconnected");
  expired = true; fireCardClick(); await flush();
  assert.equal(document.getElementById("t3-status").textContent, "Connection: disconnected", "an expired session is reflected as disconnected");
  assert.equal(document.getElementById("t3-connect").hidden, false, "an expired session restores the Connect action");
  document.getElementById("t3-panel").close();
  assert.equal(list.children.length, 0, "closing clears conversation content");
}

// Injected bindings test the handler gate, not Cloudflare's counter enforcement.
{
  const subject = "private-subject@example.com";
  let lookups = 0;
  const options = { authenticate: async () => ({ sub: subject }), findRepo: async (id) => { lookups++; return { id, owner: { login: "alice" }, name: "widget", url: "https://github.com/alice/widget" }; } };
  const request = (id = "R_123", action, extraHeaders = {}) => new Request(`https://board.example/api/t3?repoId=${id}`, action ? { method: "POST", headers: { origin: "https://board.example", "x-repo-board-request": "1", "content-type": "application/json", ...extraHeaders }, body: JSON.stringify({ action, threadId: `mock:${id}:different-thread`, text: "hello" }) } : {});
  const code = async (response, status, expected) => { assert.equal(response.status, status); assert.equal((await response.json()).error.code, expected); };
  for (const binding of [undefined, {}, { limit: async () => { throw new Error("secret failure"); } }, { limit: async () => ({}) }, { limit: async () => ({ success: "true" }) }]) {
    await code(await handleT3Request(request(), { T3_MODE: "live", BOARD_ORIGIN: "https://board.example", T3_RATE_LIMITER: binding }, options), 503, "rate_limiter_unavailable");
  }
  assert.equal(lookups, 0, "unavailable limiter must block GitHub lookup");
  const keys = [];
  const denied = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  for (const mode of ["live", "mock"]) {
    for (const action of [undefined, "list", "new", "send", "resume", "cancel"]) {
      const response = await handleT3Request(request(action === "send" ? "R_456" : "R_123", action), { T3_MODE: mode, BOARD_ORIGIN: "https://board.example", T3_RATE_LIMITER: denied }, options);
      assert.equal(response.headers.get("retry-after"), "60");
      await code(response, 429, "rate_limited");
    }
  }
  assert.equal(lookups, 0, "denied polling and writes must block GitHub lookup");
  assert.equal(new Set(keys).size, 1, "repository, thread, action and mode must not reset subject quota");
  assert.match(keys[0], /^t3:subject:v1:[a-f0-9]{64}$/);
  assert(!keys[0].includes(subject));
  const seen = keys.length;
  const env = { T3_MODE: "live", BOARD_ORIGIN: "https://board.example", T3_RATE_LIMITER: denied };
  await code(await handleT3Request(request(), env, { ...options, authenticate: verifyAccess }), 503, "auth_not_configured");
  await code(await handleT3Request(request(), { ...env, ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com", ACCESS_AUD: "test", ACCESS_ALLOWED_SUBJECTS: subject }, { ...options, authenticate: verifyAccess }), 401, "unauthorized");
  await code(await handleT3Request(request("R_123", "list", { origin: "https://evil.example" }), env, options), 403, "origin_rejected");
  await code(await handleT3Request(request("R_123", "list", { "x-repo-board-request": "" }), env, options), 403, "csrf_rejected");
  assert.equal(keys.length, seen, "auth/origin/CSRF failures must not reach limiter");
  assert.equal(lookups, 0);
  const allowed = { limit: async () => ({ success: true }) };
  const mapping = JSON.stringify([{ repoId: "R_123", owner: "alice", name: "widget", projectId: "verified", workspaceRoot: "/work/widget" }]);
  await code(await handleT3Request(request(), { T3_MODE: "live", BOARD_ORIGIN: "https://board.example", T3_RATE_LIMITER: allowed, T3_PROJECTS_JSON: mapping }, options), 503, "live_transport_unavailable");
  await code(await handleT3Request(request(), { T3_MODE: "live", BOARD_ORIGIN: "https://board.example", T3_RATE_LIMITER: allowed, T3_PROJECTS_JSON: "{}" }, options), 503, "mapping_unavailable");
  assert.equal((await handleT3Request(request(), { T3_MODE: "mock", T3_RATE_LIMITER: allowed }, options)).status, 200);
  assert.equal((await handleT3Request(request(), { T3_MODE: "mock" }, options)).status, 200);
  console.log("Workers rate limiter handler gate checks ok (injected bindings only)");
}

// Native OAuth binds single-use PKCE state and bearer credentials to the Access subject.
{
  const storage = new Map();
  const doStorage = {
    async transaction(callback) {
      return callback({
        get: async (key) => storage.get(key),
        put: async (key, value) => storage.set(key, structuredClone(value)),
        delete: async (key) => storage.delete(key),
      });
    },
  };
  const object = new T3AuthStore({ storage: doStorage });
  const namespace = { idFromName: (name) => name, get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) };
  const env = { T3_MODE: "live", T3_AUTH_STORE: namespace, BOARD_ORIGIN: "https://board.example" };
  const identity = { sub: "subject-A" };
  let registered, exchanged;
  const fetcher = async (url, init) => {
    assert.equal(new URL(url).origin, "https://t3.jeppesen.cc");
    if (url.endsWith("/oauth/mcp/register")) {
      registered = JSON.parse(init.body);
      return Response.json({ client_id: "public-client-1" });
    }
    assert.equal(url, "https://t3.jeppesen.cc/oauth/mcp/token");
    exchanged = new URLSearchParams(init.body);
    return Response.json({ access_token: "t3-secret-token", token_type: "Bearer", expires_in: 3600, scope: "orchestration:read" });
  };
  const options = { authenticate: async () => identity, fetcher, rateLimit: async () => {} };
  const bootstrap = await handleT3AuthRequest(new Request("https://board.example/api/t3/auth/session", { headers: { "x-repo-board-request": "1" } }), env, options);
  const csrf = (await bootstrap.json()).csrf;
  const sid = bootstrap.headers.get("set-cookie").match(/__Host-repo-board-t3=([^;]+)/)[1];
  const invalidStart = await handleT3AuthRequest(new Request("https://board.example/api/t3/auth/start", { method: "POST", headers: { origin: "https://board.example", "content-type": "application/json", "x-repo-board-request": "1", "x-repo-board-csrf": "wrong", cookie: `__Host-repo-board-t3=${sid}` }, body: '{"csrf":"wrong"}' }), env, options);
  assert.equal(invalidStart.status, 403);
  assert.equal(registered, undefined, "CSRF failure does not contact OAuth registration");
  const csrfRequest = new Request("https://board.example/api/t3/auth/start", { method: "POST", headers: { origin: "https://board.example", "content-type": "application/json", "x-repo-board-request": "1", "x-repo-board-csrf": csrf, cookie: `__Host-repo-board-t3=${sid}` }, body: JSON.stringify({ csrf }) });
  const start = await handleT3AuthRequest(csrfRequest, env, options);
  assert.equal(start.status, 200);
  assert.deepEqual(registered.grant_types, ["authorization_code"]);
  assert.deepEqual(registered.redirect_uris, ["https://board.example/api/t3/auth/callback"]);
  const authorization = new URL((await start.json()).authorizationUrl);
  assert.equal(authorization.origin, "https://t3.jeppesen.cc");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("resource"), "https://t3.jeppesen.cc/mcp");
  assert.equal(authorization.searchParams.get("scope"), null, "T3 approval UI controls the granted scope");
  assert.equal(start.headers.get("set-cookie"), null, "start does not rotate the browser session cookie");
  const callbackUrl = `https://board.example/api/t3/auth/callback?code=authorization-code&state=${encodeURIComponent(authorization.searchParams.get("state"))}&iss=https%3A%2F%2Ft3.jeppesen.cc`;
  const wrongSubject = await handleT3AuthRequest(new Request(callbackUrl, { headers: { cookie: `__Host-repo-board-t3=${sid}` } }), env, { ...options, authenticate: async () => ({ sub: "subject-B" }) });
  assert.equal(new URL(wrongSubject.headers.get("location")).searchParams.get("reason"), "oauth_state_invalid");
  const wrongBrowser = await handleT3AuthRequest(new Request(callbackUrl, { headers: { cookie: "__Host-repo-board-t3=wrong-browser" } }), env, options);
  assert.equal(new URL(wrongBrowser.headers.get("location")).searchParams.get("reason"), "oauth_state_invalid");
  const wrongState = callbackUrl.replace(authorization.searchParams.get("state"), "wrong-state");
  const stateMismatch = await handleT3AuthRequest(new Request(wrongState, { headers: { cookie: `__Host-repo-board-t3=${sid}` } }), env, options);
  assert.equal(new URL(stateMismatch.headers.get("location")).searchParams.get("reason"), "oauth_state_invalid");
  const callback = await handleT3AuthRequest(new Request(callbackUrl, { headers: { cookie: `__Host-repo-board-t3=${sid}` } }), env, options);
  assert.equal(callback.status, 303);
  assert.equal(new URL(callback.headers.get("location")).searchParams.get("t3"), "connected");
  assert.equal(new URL(callback.headers.get("location")).searchParams.get("repoId"), "R_kgDOUSfguQ", "success callback reopens the verified repository panel");
  assert(!callback.headers.get("set-cookie").includes("t3-secret-token"));
  assert.equal(exchanged.get("grant_type"), "authorization_code");
  assert.equal(exchanged.get("code_verifier")?.length > 40, true);
  assert.equal(exchanged.get("redirect_uri"), "https://board.example/api/t3/auth/callback");
  assert.equal(JSON.stringify(storage.get("record")).includes("t3-secret-token"), true, "access token remains in server Durable Object storage");
  const session = await handleT3AuthRequest(new Request("https://board.example/api/t3/auth/session", { headers: { "x-repo-board-request": "1", cookie: `__Host-repo-board-t3=${sid}` } }), env, options);
  const sessionBody = await session.json();
  assert.equal(sessionBody.connected, true);
  assert.equal(sessionBody.csrf, csrf);
  assert(!JSON.stringify(sessionBody).includes("t3-secret-token"));
  const replay = await handleT3AuthRequest(new Request(callbackUrl, { headers: { cookie: `__Host-repo-board-t3=${sid}` } }), env, options);
  assert.equal(new URL(replay.headers.get("location")).searchParams.get("reason"), "oauth_state_invalid");
  assert.equal(storage.get("record").session.accessToken, "t3-secret-token");
  assert.equal(replay.headers.get("set-cookie"), null, "an invalid callback cannot clear an existing browser session");
  const disconnected = await handleT3AuthRequest(new Request("https://board.example/api/t3/auth/disconnect", { method: "POST", headers: { origin: "https://board.example", "content-type": "application/json", "x-repo-board-request": "1", "x-repo-board-csrf": csrf, cookie: `__Host-repo-board-t3=${sid}` }, body: JSON.stringify({ csrf }) }), env, options);
  assert.equal(disconnected.status, 200);
  assert.equal(storage.has("record"), false);
  storage.set("record", { session: { subject: "subject-A", sid, accessToken: "expired-token", expiresAt: Date.now() - 1 }, csrf: { sid, subject: "subject-A", token: csrf, expiresAt: Date.now() + 60_000 } });
  const cleanup = await object.fetch(new Request("https://auth-store.internal/state", { method: "POST", headers: { "x-t3-store-action": "read" }, body: JSON.stringify({ sid, subject: "subject-A" }) }));
  assert.deepEqual(await cleanup.json(), { session: null, csrf, sid });
  assert.equal(storage.get("record").session, undefined, "expired credentials are deleted on access");
  console.log("native OAuth PKCE, subject binding, single-use callback, session secrecy and disconnect checks ok");
}

// Browser sessions are isolated by subject plus the hash of each random cookie.
{
  const instances = new Map();
  const namespace = {
    idFromName: (name) => name,
    get: (id) => {
      if (!instances.has(id)) {
        const storage = new Map();
        const object = new T3AuthStore({ storage: { async transaction(fn) { return fn({ get: async (key) => storage.get(key), put: async (key, value) => storage.set(key, structuredClone(value)), delete: async (key) => storage.delete(key) }); } } });
        instances.set(id, { object, storage });
      }
      const { object } = instances.get(id);
      return { fetch: (url, init) => object.fetch(new Request(url, init)) };
    },
  };
  const env = { T3_MODE: "live", BOARD_ORIGIN: "https://board.example", T3_AUTH_STORE: namespace };
  const options = { authenticate: async () => ({ sub: "same-access-subject" }), rateLimit: async () => {} };
  const sessionRequest = (cookie = "", origin = "") => new Request("https://board.example/api/t3/auth/session", { headers: { "x-repo-board-request": "1", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
  const first = await handleT3AuthRequest(sessionRequest(), env, options);
  const second = await handleT3AuthRequest(sessionRequest(), env, options);
  const firstSid = first.headers.get("set-cookie").match(/__Host-repo-board-t3=([^;]+)/)[1];
  const secondSid = second.headers.get("set-cookie").match(/__Host-repo-board-t3=([^;]+)/)[1];
  assert.notEqual(firstSid, secondSid, "separate browsers receive independent random session IDs");
  const firstBody = await first.json(), secondBody = await second.json();
  assert.equal(firstBody.connected, false);
  assert.equal(secondBody.connected, false);
  assert.notEqual(firstBody.csrf, secondBody.csrf, "browser CSRF values are isolated");
  const firstStoreName = [...instances.keys()][0];
  const firstStore = instances.get(firstStoreName).object;
  const connect = await firstStore.fetch(new Request("https://auth-store.internal/state", { method: "POST", headers: { "x-t3-store-action": "connect" }, body: JSON.stringify({ subject: "same-access-subject", sid: firstSid, accessToken: "private-token", expiresAt: Date.now() + 60_000 }) }));
  assert.equal(connect.status, 200);
  const firstAgain = await handleT3AuthRequest(sessionRequest(`__Host-repo-board-t3=${firstSid}`), env, options);
  const secondAgain = await handleT3AuthRequest(sessionRequest(`__Host-repo-board-t3=${secondSid}`), env, options);
  assert.equal((await firstAgain.json()).connected, true);
  const secondPayload = await secondAgain.json();
  assert.equal(secondPayload.connected, false, "a different browser with the same Access subject cannot read the saved credential");
  assert(!JSON.stringify(secondPayload).includes("private-token"));
  const badOrigin = await handleT3AuthRequest(sessionRequest(`__Host-repo-board-t3=${firstSid}`, "https://evil.example"), env, options);
  assert.equal(badOrigin.status, 403, "the session read rejects cross-origin requests");
}

// OAuth callbacks require one exact issuer and consume safe error callbacks once.
{
  const storage = new Map();
  const object = new T3AuthStore({ storage: { async transaction(fn) { return fn({ get: async (key) => storage.get(key), put: async (key, value) => storage.set(key, structuredClone(value)), delete: async (key) => storage.delete(key) }); } } });
  const namespace = { idFromName: (name) => name, get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) };
  const env = { T3_MODE: "live", BOARD_ORIGIN: "https://board.example", T3_AUTH_STORE: namespace };
  let tokenCalls = 0;
  const fetcher = async (url) => {
    if (url.endsWith("/register")) return Response.json({ client_id: "client" });
    tokenCalls++;
    return Response.json({ access_token: "oauth-secret", token_type: "Bearer", expires_in: 600, scope: "orchestration:read" });
  };
  const options = { authenticate: async () => ({ sub: "issuer-user" }), fetcher, rateLimit: async () => {} };
  const bootstrap = await handleT3AuthRequest(new Request("https://board.example/api/t3/auth/session", { headers: { "x-repo-board-request": "1" } }), env, options);
  const sid = bootstrap.headers.get("set-cookie").match(/__Host-repo-board-t3=([^;]+)/)[1];
  const csrf = (await bootstrap.json()).csrf;
  const start = await handleT3AuthRequest(new Request("https://board.example/api/t3/auth/start", { method: "POST", headers: { origin: "https://board.example", "content-type": "application/json", "x-repo-board-request": "1", "x-repo-board-csrf": csrf, cookie: `__Host-repo-board-t3=${sid}` }, body: JSON.stringify({ csrf }) }), env, options);
  const state = new URL((await start.json()).authorizationUrl).searchParams.get("state");
  for (const suffix of [`state=${state}`, `state=${state}&iss=https%3A%2F%2Fevil.example`, `state=${state}&iss=https%3A%2F%2Ft3.jeppesen.cc&iss=https%3A%2F%2Ft3.jeppesen.cc`]) {
    const response = await handleT3AuthRequest(new Request(`https://board.example/api/t3/auth/callback?code=x&${suffix}`, { headers: { cookie: `__Host-repo-board-t3=${sid}` } }), env, options);
    assert.equal(new URL(response.headers.get("location")).searchParams.get("reason"), "oauth_callback_invalid");
  }
  assert.equal(tokenCalls, 0, "missing, wrong, and duplicate issuers never reach code exchange");
  const denied = await handleT3AuthRequest(new Request(`https://board.example/api/t3/auth/callback?error=access_denied&error_description=private-error-text&state=${state}&iss=https%3A%2F%2Ft3.jeppesen.cc`, { headers: { cookie: `__Host-repo-board-t3=${sid}` } }), env, options);
  const deniedUrl = new URL(denied.headers.get("location"));
  assert.equal(deniedUrl.searchParams.get("reason"), "oauth_denied");
  assert(!denied.headers.get("location").includes("private-error-text"));
  assert.equal(tokenCalls, 0, "validated error callback consumes state without exchanging a code");
  const replay = await handleT3AuthRequest(new Request(`https://board.example/api/t3/auth/callback?error=access_denied&state=${state}&iss=https%3A%2F%2Ft3.jeppesen.cc`, { headers: { cookie: `__Host-repo-board-t3=${sid}` } }), env, options);
  assert.equal(new URL(replay.headers.get("location")).searchParams.get("reason"), "oauth_state_invalid");
}

// Broader or absent OAuth grants are rejected, and MCP reads remain pinned to one project/thread.
{
  const storage = new Map();
  const doStorage = { async transaction(callback) { return callback({ get: async (k) => storage.get(k), put: async (k, v) => storage.set(k, structuredClone(v)), delete: async (k) => storage.delete(k) }); } };
  const object = new T3AuthStore({ storage: doStorage });
  const namespace = { idFromName: (name) => name, get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) };
  const baseEnv = { T3_MODE: "live", BOARD_ORIGIN: "https://board.example", T3_AUTH_STORE: namespace };
  const user = { sub: "read-only-user" };
  const fetchOAuth = async (scope) => async (url) => url.endsWith("register") ? Response.json({ client_id: "client" }) : Response.json({ access_token: "must-not-store", token_type: "Bearer", expires_in: 600, ...(scope === undefined ? {} : { scope }) });
  const opts = (fetcher) => ({ authenticate: async () => user, fetcher, rateLimit: async () => {} });
  const startFlow = async (fetcher) => {
    const options = opts(fetcher);
    const bootstrap = await handleT3AuthRequest(new Request("https://board.example/api/t3/auth/session", { headers: { "x-repo-board-request": "1" } }), baseEnv, options);
    const csrf = (await bootstrap.json()).csrf;
    const sid = bootstrap.headers.get("set-cookie").match(/__Host-repo-board-t3=([^;]+)/)[1];
    const start = await handleT3AuthRequest(new Request("https://board.example/api/t3/auth/start", { method: "POST", headers: { origin: "https://board.example", "content-type": "application/json", "x-repo-board-request": "1", "x-repo-board-csrf": csrf, cookie: `__Host-repo-board-t3=${sid}` }, body: JSON.stringify({ csrf }) }), baseEnv, options);
    return { start, sid };
  };
  const bad = await startFlow(await fetchOAuth("orchestration:operate"));
  const badStart = bad.start;
  const badAuth = new URL((await badStart.json()).authorizationUrl);
  const badCallback = await handleT3AuthRequest(new Request(`https://board.example/api/t3/auth/callback?code=x&state=${badAuth.searchParams.get("state")}&iss=https%3A%2F%2Ft3.jeppesen.cc`, { headers: { cookie: `__Host-repo-board-t3=${bad.sid}` } }), baseEnv, opts(await fetchOAuth("orchestration:operate")));
  assert.equal(new URL(badCallback.headers.get("location")).searchParams.get("reason"), "t3_scope_rejected");
  assert.equal(storage.has("record"), false);

  const scopeless = await startFlow(await fetchOAuth(undefined));
  const scopelessStart = scopeless.start;
  const scopeUrl = new URL((await scopelessStart.json()).authorizationUrl);
  const scopeCallback = await handleT3AuthRequest(new Request(`https://board.example/api/t3/auth/callback?code=x&state=${scopeUrl.searchParams.get("state")}&iss=https%3A%2F%2Ft3.jeppesen.cc`, { headers: { cookie: `__Host-repo-board-t3=${scopeless.sid}` } }), baseEnv, opts(await fetchOAuth(undefined)));
  assert.equal(new URL(scopeCallback.headers.get("location")).searchParams.get("reason"), "t3_scope_rejected");
  assert.equal(storage.has("record"), false);

  const repo = { id: "R_kgDOUSfguQ", owner: { login: "swamp2k" }, name: "glb-viewer", url: "https://github.com/swamp2k/glb-viewer" };
  const mapping = [{ repoId: repo.id, owner: "swamp2k", name: "glb-viewer", projectId: "mcp:6ccdf28e-d941-4b71-a636-a344020b5643", workspaceRoot: "/projects/glb-viewer" }];
  const id = "mcp:6ccdf28e-d941-4b71-a636-a344020b5643";
  const validBrowserSid = "A".repeat(43);
  const record = { session: { subject: user.sub, sid: validBrowserSid, accessToken: "server-token", expiresAt: Date.now() + 60_000 } };
  const authStub = { fetch: async () => Response.json(record) };
  const authNamespace = { idFromName: () => user.sub, get: () => authStub };
  const env = { ...baseEnv, T3_AUTH_STORE: authNamespace, T3_PROJECTS_JSON: JSON.stringify(mapping) };
  const calls = [];
  const mcpFetch = async (url, init) => {
    assert.equal(url, "https://t3.jeppesen.cc/mcp");
    assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer server-token");
    const body = JSON.parse(init.body); calls.push(body);
    if (body.method === "notifications/initialized") { assert.equal(body.id, undefined); return new Response(null, { status: 202 }); }
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "mcp-session-id": "session-1", "mcp-protocol-version": "2025-06-18" } });
    if (body.method !== "tools/call") throw Error("unexpected write");
    assert.equal(new Headers(init.headers).get("mcp-session-id"), "session-1");
    let result;
    if (body.params.name === "t3_project_read") result = { structuredContent: { id, workspaceRoot: "/projects/glb-viewer", repositoryIdentity: { canonicalKey: "github.com/swamp2k/glb-viewer", rootPath: "/projects/glb-viewer" } } };
    else if (body.params.name === "t3_thread_list") result = { structuredContent: { projectId: id, threads: [{ threadId: "thread-1", projectId: id, title: "Inspect", status: "completed" }], nextCursor: 50, total: 1 } };
    else if (body.params.name === "t3_thread_read") result = { structuredContent: { thread: { threadId: "thread-1", projectId: id, title: "Inspect", status: "completed" }, items: [{ position: 0, itemId: "item-1", type: "user_message", createdBy: "user", text: "User note", createdAt: "2026-11-03T00:00:00Z" }, { position: 1, itemId: "item-2", type: "assistant_message", createdBy: "agent", text: "Read only content", createdAt: "2026-11-03T00:00:01Z" }], nextPosition: 2, hasMore: true, recentRuns: [] } };
    else throw Error("unexpected tool");
    if (body.params.name === "t3_thread_list") return new Response(`data: {"jsonrpc":"2.0","id":"unrelated","result":{}}\n\ndata: {"jsonrpc":"2.0",\ndata: "id":"${body.id}",\ndata: "result":${JSON.stringify(result)}}\n\n`, { headers: { "content-type": "text/event-stream" } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  const req = new Request(`https://board.example/api/t3?repoId=${repo.id}&threadId=thread-1`, { headers: { cookie: `__Host-repo-board-t3=${validBrowserSid}` } });
  const read = await liveRead(req, env, user, repo, mcpFetch);
  assert.equal(read.status, 200);
  const payload = await read.json();
  assert.equal(payload.mode, "live-read-only");
  assert.equal(payload.selected.items[0].createdBy, "user");
  assert.equal(payload.selected.items[1].type, "assistant_message");
  assert.equal(payload.selected.items[1].text, "Read only content");
  assert.equal(payload.selected.hasMore, true);
  assert.equal(payload.selected.itemsTruncated, false);
  assert.equal(payload.nextCursor, 50);
  assert.equal(payload.truncated, false);
  assert.equal(calls.find((x) => x.params?.name === "t3_thread_list").params.arguments.limit, 50);
  const readArgs = calls.find((x) => x.params?.name === "t3_thread_read").params.arguments;
  assert.deepEqual({ view: readArgs.view, limit: readArgs.limit, maxCharsPerItem: readArgs.maxCharsPerItem }, { view: "messages", limit: 100, maxCharsPerItem: 10_000 });
  assert.deepEqual(calls.filter((x) => x.method === "tools/call").map((x) => x.params.name), ["t3_project_read", "t3_thread_list", "t3_thread_read"]);
  assert(calls.every((x) => !["tools/call"].includes(x.method) || ["t3_project_read", "t3_thread_list", "t3_thread_read"].includes(x.params.name)));
  calls.length = 0;
  await liveRead(new Request(req.url + "&cursor=50&position=0", { headers: req.headers }), env, user, repo, mcpFetch);
  assert.equal(calls.find((x) => x.params?.name === "t3_thread_list").params.arguments.cursor, 50, "native thread cursors are numbers");
  const nextReadArgs = calls.find((x) => x.params?.name === "t3_thread_read").params.arguments;
  assert.equal(nextReadArgs.afterPosition, 0, "native message pagination uses afterPosition, including zero");
  assert.equal(nextReadArgs.position, undefined);
  await assert.rejects(() => liveRead(new Request(req.url + "&cursor=invalid", { headers: req.headers }), env, user, repo, mcpFetch), /page is invalid/);
  const overLimit = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.params?.name === "t3_thread_list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { projectId: id, threads: Array.from({ length: 51 }, (_, i) => ({ threadId: `thread-${i + 1}`, projectId: id })), total: 51 } } });
    if (body.params?.name === "t3_thread_read") return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { thread: { threadId: "thread-1", projectId: id }, items: Array.from({ length: 101 }, (_, i) => ({ type: "assistant_message", createdBy: "agent", text: `item ${i}` })), hasMore: false } } });
    return mcpFetch(url, init);
  };
  const capped = await (await liveRead(req, env, user, repo, overLimit)).json();
  assert.equal(capped.conversations.length, 50);
  assert.equal(capped.truncated, true);
  assert.equal(capped.hasMore, true);
  assert.equal(capped.selected.items.length, 100);
  assert.equal(capped.selected.itemsTruncated, true);
  assert.equal(capped.selected.hasMore, true);
  const noMembership = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.params?.name === "t3_thread_list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { projectId: id, threads: [{ threadId: "other", projectId: "other-project" }] } } });
    return mcpFetch(url, init);
  };
  await assert.rejects(() => liveRead(req, env, user, repo, noMembership), /did not belong to this project/, "cross-project list results are rejected before messages are read");
  await assert.rejects(() => liveRead(req, { ...env, T3_PROJECTS_JSON: JSON.stringify([{ ...mapping[0], workspaceRoot: "/home/glb-viewer" }]) }, user, repo, mcpFetch), /Only the verified glb-viewer/);
  await assert.rejects(() => liveRead(req, env, user, repo, async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.params?.name === "t3_project_read") return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { id, workspaceRoot: "/projects/glb-viewer", repositoryIdentity: "R_kgDOUSfguQ" } } });
    return mcpFetch(url, init);
  }), /project identity did not match/, "opaque GitHub IDs are not compared as T3 repository identities");
  await assert.rejects(() => liveRead(req, env, user, repo, async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.params?.name === "t3_thread_read") return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { thread: { threadId: "different-thread", projectId: id }, items: [] } } });
    return mcpFetch(url, init);
  }), /did not belong to this project/, "thread_read must return the exact requested thread id");
  await assert.rejects(() => liveRead(new Request(req.url, { headers: { cookie: `__Host-repo-board-t3=${"B".repeat(43)}` } }), env, user, repo, mcpFetch), /Connect to T3/);
  await assert.rejects(() => liveRead(req, env, { sub: "other-subject" }, repo, mcpFetch), /Connect to T3/, "a different Access subject cannot reuse the stored bearer session");

  const toolsFailure = (status, body = "upstream-secret-token") => async (url, init) => {
    const requestBody = JSON.parse(init.body);
    if (requestBody.method === "tools/call") return new Response(body, { status, headers: { "content-type": "application/json" } });
    return mcpFetch(url, init);
  };
  for (const [status, message] of [[401, "T3 sign-in expired; disconnect and reconnect"], [503, "T3 conversations could not be loaded"]]) {
    await assert.rejects(() => liveRead(req, env, user, repo, toolsFailure(status)), (error) => error.status === (status === 401 ? 401 : 502) && error.message.startsWith(message) && !error.message.includes("secret"));
  }
  await assert.rejects(() => liveRead(req, env, user, repo, async (url, init) => {
    if (JSON.parse(init.body).method === "tools/call") throw Error("network-secret-token");
    return mcpFetch(url, init);
  }), (error) => error.status === 502 && !error.message.includes("network-secret"));
  await assert.rejects(() => liveRead(req, env, user, repo, async (url, init) => {
    if (JSON.parse(init.body).method === "tools/call") throw new DOMException("timeout access_token=private", "TimeoutError");
    return mcpFetch(url, init);
  }), (error) => error.status === 502 && error.message.startsWith("T3 conversations could not be loaded") && !error.message.includes("private"));
  await assert.rejects(() => liveRead(req, env, user, repo, async (url, init) => {
    const call = JSON.parse(init.body);
    if (call.params?.name === "t3_thread_list") return Response.json({ jsonrpc: "2.0", id: "wrong-id", result: {} });
    return mcpFetch(url, init);
  }), /invalid conversation response/, "JSON-RPC response ids are correlated");
  let bodyCancelled = false;
  const oversizedFetch = async (url, init) => {
    if (JSON.parse(init.body).method === "tools/call") return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1_000_001)); }, cancel() { bodyCancelled = true; } }), { headers: { "content-type": "application/json" } });
    return mcpFetch(url, init);
  };
  await assert.rejects(() => liveRead(req, env, user, repo, oversizedFetch), /too much conversation data/);
  assert.equal(bodyCancelled, true, "oversized upstream bodies are cancelled immediately");
  const publicError = await handleT3Request(new Request("https://board.example/api/t3?repoId=R_123", { headers: { cookie: `__Host-repo-board-t3=${validBrowserSid}` } }), { T3_MODE: "live", BOARD_ORIGIN: "https://board.example", T3_PROJECTS_JSON: JSON.stringify([{ repoId: "R_123", owner: "alice", name: "widget", projectId: "verified", workspaceRoot: "/work/widget" }]), T3_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { authenticate: async () => user, findRepo: async () => ({ id: "R_123", owner: { login: "alice" }, name: "widget", url: "https://github.com/alice/widget" }), liveRead: async () => { throw Error("secret access_token=private-value"); } });
  assert.equal(publicError.status, 502);
  assert(!(await publicError.text()).includes("private-value"), "untrusted upstream errors are redacted from the browser response");
  console.log("read-only MCP JSON/SSE transport, project membership, cookie binding and tool allowlist checks ok");
}

// Live send: only allowlisted emails, only with an operate grant, only into conversations of the verified project.
{
  const sid = "A".repeat(43);
  const repo = { id: "R_kgDOUSfguQ", owner: { login: "swamp2k" }, name: "glb-viewer", url: "https://github.com/swamp2k/glb-viewer" };
  const projectId = "mcp:6ccdf28e-d941-4b71-a636-a344020b5643";
  const makeEnv = (canOperate) => ({
    T3_SEND_EMAILS: "owner@example.com",
    T3_PROJECTS_JSON: JSON.stringify([{ repoId: repo.id, owner: "swamp2k", name: "glb-viewer", projectId, workspaceRoot: "/projects/glb-viewer" }]),
    T3_AUTH_STORE: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ sid, csrf: "csrf-1", session: { sid, subject: "sub-1", accessToken: "tok", canOperate, expiresAt: Date.now() + 60_000 } }) }) },
  });
  const sendRequest = (csrf = "csrf-1") => new Request("https://board.example/api/t3?repoId=R_kgDOUSfguQ", { method: "POST", headers: { cookie: `__Host-repo-board-t3=${sid}`, "content-type": "application/json", "x-repo-board-csrf": csrf }, body: JSON.stringify({ csrf, threadId: "th-1", message: "Go ahead" }) });
  const makeFetch = (threadProject, sent) => async (url, init) => {
    const call = JSON.parse(init.body);
    if (call.method === "initialize") return Response.json({ jsonrpc: "2.0", id: call.id, result: { protocolVersion: "2025-06-18" } });
    if (call.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (call.params.name === "t3_thread_read") return Response.json({ jsonrpc: "2.0", id: call.id, result: { structuredContent: { thread: { threadId: "th-1", projectId: threadProject } } } });
    if (call.params.name === "t3_thread_send") { sent.push(call.params.arguments); return Response.json({ jsonrpc: "2.0", id: call.id, result: { structuredContent: { ok: true } } }); }
    throw Error("unexpected tool " + call.params.name);
  };
  const owner = { sub: "sub-1", email: "owner@example.com" };
  let sent = [];
  const ok = await liveSend(sendRequest(), makeEnv(true), owner, repo, makeFetch(projectId, sent));
  assert.equal((await ok.json()).sent, true);
  assert.equal(sent.length, 1); assert.equal(sent[0].threadId, "th-1"); assert.equal(sent[0].message, "Go ahead"); assert.equal(sent[0].mode, "queue");
  sent = [];
  await assert.rejects(() => liveSend(sendRequest(), makeEnv(true), { sub: "sub-1", email: "reader@example.com" }, repo, makeFetch(projectId, sent)), (e) => e.code === "t3_send_not_allowed");
  await assert.rejects(() => liveSend(sendRequest(), makeEnv(false), owner, repo, makeFetch(projectId, sent)), (e) => e.code === "t3_send_not_permitted");
  await assert.rejects(() => liveSend(sendRequest("wrong"), makeEnv(true), owner, repo, makeFetch(projectId, sent)), (e) => e.code === "csrf_rejected");
  await assert.rejects(() => liveSend(sendRequest(), makeEnv(true), owner, repo, makeFetch("mcp:other", sent)), (e) => e.code === "thread_mismatch");
  assert.equal(sent.length, 0, "nothing is sent when any check fails");
  console.log("live send allowlist, operate grant, CSRF and project membership checks ok");
}
