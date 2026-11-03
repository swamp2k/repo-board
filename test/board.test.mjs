import { parseNow, laneFor, renderBoard, page, promptsFor, buildBoard, t3InspectionPrompt } from "../src/worker.js";
import assert from "node:assert";
import { canonicalRepo, resolveProject, verifyAccess, handleT3Request } from "../src/t3.js";
import { createT3Client } from "../src/t3-client.js";

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

// Stable GitHub IDs survive name changes and avoid owner/name collisions.
{
  const mockEnv = { T3_MODE: "mock" };
  const before = { id: "R_123", owner: { login: "alice" }, name: "widget", url: "https://github.com/alice/widget" };
  const renamed = { ...before, owner: { login: "alice-new" }, name: "widget-next", url: "https://github.com/alice-new/widget-next" };
  const a = resolveProject(before, mockEnv), b = resolveProject(renamed, mockEnv);
  assert.equal(a.projectId, b.projectId);
  assert.equal(a.workspaceRoot, "/mock/alice/widget");
  assert.equal(b.fullName, "alice-new/widget-next");
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
  const authenticate = async () => ({ sub: "test" });
  const request = () => new Request("https://board.example/api/t3?repoId=R_123", { method: "POST", headers: { origin: "https://board.example", "x-repo-board-request": "1", "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) });
  const mapping = JSON.stringify([{ repoId: "R_123", owner: "alice", name: "widget", projectId: "verified-project", workspaceRoot: "/work/alice/widget" }]);
  const res = await handleT3Request(request(), { T3_MODE: "live", T3_PROJECTS_JSON: mapping }, { authenticate, findRepo: async () => repo });
  assert.equal(res.status, 503);
  assert((await res.text()).includes("verified remote API"));
  const off = await handleT3Request(request(), {}, { authenticate, findRepo: async () => repo });
  assert.equal(off.status, 503);
  console.log("UI, prompt regression and fail-closed modes ok");
}
