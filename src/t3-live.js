// Native T3 OAuth and read-only MCP client. Credentials and PKCE state stay in a
// Durable Object scoped by the Access subject and opaque per-browser cookie.
import { T3Error, canonicalRepo, readLimited } from "./t3.js";

export const T3_ISSUER = "https://t3.jeppesen.cc";
const AUTHORIZE = `${T3_ISSUER}/oauth/mcp/authorize`;
const TOKEN = `${T3_ISSUER}/oauth/mcp/token`;
const REGISTER = `${T3_ISSUER}/oauth/mcp/register`;
const MCP = `${T3_ISSUER}/mcp`;
const RESOURCE = MCP;
const SCOPE = "orchestration:read";
const COOKIE = "__Host-repo-board-t3";
const MAX_RESPONSE = 1_000_000;
const MAX_THREADS = 50;
const MAX_ITEMS = 100;
const MAX_ITEM_CHARS = 10_000;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const fail = (status, code, message) => new T3Error(status, code, message);
const random = (length = 32) => { const b = crypto.getRandomValues(new Uint8Array(length)); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const sha256 = async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...headers } });
const cookieValue = (request) => (request.headers.get("cookie") || "").split(";").map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
const cookieHeader = (sid, age = 86400) => `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const fixedFetch = (fetcher, url, init) => fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });

function boardOrigin(env, request) {
  let configured;
  try { configured = new URL(env.BOARD_ORIGIN || ""); } catch { throw fail(503, "oauth_not_configured", "Native T3 sign-in is not configured"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(configured.hostname);
  if ((configured.protocol !== "https:" && !(configured.protocol === "http:" && loopback)) || configured.username || configured.password || configured.pathname !== "/" || configured.search || configured.hash) throw fail(503, "oauth_not_configured", "Native T3 sign-in is not configured");
  if (new URL(request.url).origin !== configured.origin) throw fail(403, "origin_rejected", "Request origin is not allowed");
  return configured.origin;
}

function validSid(sid) { return typeof sid === "string" && /^[A-Za-z0-9_-]{43}$/.test(sid); }

async function storeFor(identity, env, sid) {
  if (!identity?.sub || typeof identity.sub !== "string" || identity.sub.length > 512 || !env.T3_AUTH_STORE) throw fail(503, "auth_store_unavailable", "T3 sign-in storage is unavailable");
  if (!validSid(sid)) throw fail(401, "t3_not_connected", "Connect to T3 to read conversations");
  const namespaceKey = b64url(await sha256(`${identity.sub}\u0000${sid}`));
  const id = env.T3_AUTH_STORE.idFromName(`browser-session:${namespaceKey}`);
  return env.T3_AUTH_STORE.get(id);
}

async function storeCall(stub, action, data) {
  const response = await stub.fetch("https://auth-store.internal/state", { method: "POST", headers: { "content-type": "application/json", "x-t3-store-action": action }, body: JSON.stringify(data || {}) });
  if (!response.ok) throw fail(503, "auth_store_unavailable", "T3 sign-in storage is unavailable");
  return response.json();
}

function parseCookieSession(request, identity, record) {
  const sid = cookieValue(request);
  if (!sid || !record?.session || record.session.subject !== identity.sub || record.session.sid !== sid || record.session.expiresAt <= Date.now()) throw fail(401, "t3_not_connected", "Connect to T3 to read conversations");
  return record.session;
}

// Registration and token steps: report which sub-step failed (safe codes, no secrets) so a failed sign-in can be diagnosed.
async function stepFetch(step, fetcher, url, init) {
  let response;
  try { response = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) }); } catch (e) { throw fail(502, `t3_${step}_unreachable`, `T3 sign-in could not be completed (could not reach T3 ${step}: ${e?.name === "TimeoutError" ? "timeout" : e?.name === "AbortError" ? "aborted" : "network error"})`); }
  if (response.status >= 300 && response.status < 400) { let host = "unknown"; try { host = new URL(response.headers.get("location") || "", url).hostname; } catch { /* keep unknown */ } throw fail(502, `t3_${step}_redirected`, `T3 sign-in could not be completed (T3 ${step} was redirected, HTTP ${response.status}, to ${host})`); }
  if (!response.ok) {
    let oauthError = "";
    try { const body = await safeJson(response.clone()); if (typeof body?.error === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(body.error)) oauthError = `, T3 said: ${body.error}`; } catch { /* no detail */ }
    throw fail(502, `t3_${step}_rejected`, `T3 sign-in could not be completed (T3 ${step} answered HTTP ${response.status}${oauthError})`);
  }
  return response;
}
const registerFetch = (fetcher, url, init) => stepFetch("registration", fetcher, url, init);
const tokenFetch = (fetcher, url, init) => stepFetch("token", fetcher, url, init);

async function safeJson(response, maxBytes = 32_000) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw fail(502, "t3_oauth_unavailable", "T3 sign-in could not be completed");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw fail(502, "t3_oauth_unavailable", "T3 sign-in could not be completed"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

async function begin(request, env, identity, fetcher) {
  const origin = boardOrigin(env, request);
  if (request.headers.get("origin") !== origin || request.headers.get("x-repo-board-request") !== "1" || !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw fail(403, "csrf_rejected", "Request could not be verified");
  const body = await readLimited(request).then((text) => JSON.parse(text)).catch(() => null);
  const sid = cookieValue(request);
  if (!validSid(sid)) throw fail(401, "t3_not_connected", "Connect to T3 to read conversations");
  const stub = await storeFor(identity, env, sid);
  const browserSession = await storeCall(stub, "read", { sid, subject: identity.sub });
  if (!body || !browserSession.csrf || browserSession.csrf !== body.csrf || body.csrf !== request.headers.get("x-repo-board-csrf") || !cookieValue(request) || cookieValue(request) !== browserSession.sid) throw fail(403, "csrf_rejected", "Request could not be verified");
  const callback = `${origin}/api/t3/auth/callback`;
  const client = await registerFetch(fetcher, REGISTER, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_name: "Repo Board read-only pilot", redirect_uris: [callback], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  const clientInfo = await safeJson(client);
  if (!clientInfo || typeof clientInfo.client_id !== "string" || !clientInfo.client_id || clientInfo.client_id.length > 512) throw fail(502, "t3_register_invalid", "T3 sign-in could not be completed (T3 registration reply had no client id)");
  const verifier = random(48), state = random(32);
  const challenge = b64url(await sha256(verifier));
  const pending = { state, verifier, sid, subject: identity.sub, clientId: clientInfo.client_id, callback, issuer: T3_ISSUER, expiresAt: Date.now() + 5 * 60_000 };
  await storeCall(stub, "begin", pending);
  const target = new URL(AUTHORIZE);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: clientInfo.client_id, redirect_uri: callback, state, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE })) target.searchParams.set(key, value);
  return json({ authorizationUrl: target.href });
}

async function callback(request, env, identity, fetcher) {
  const origin = boardOrigin(env, request);
  if (!request.headers.get("cookie")) throw fail(401, "oauth_session_missing", "T3 sign-in could not be completed");
  const params = new URL(request.url).searchParams;
  for (const name of ["state", "code", "iss", "error"]) if (params.getAll(name).length > 1) throw fail(400, "oauth_callback_invalid", "T3 sign-in could not be completed");
  const state = params.get("state"), code = params.get("code"), issuer = params.get("iss"), oauthError = params.get("error");
  if (!state || state.length > 512 || issuer !== T3_ISSUER || (oauthError ? code : !code) || (code && code.length > 4096)) throw fail(400, "oauth_callback_invalid", "T3 sign-in could not be completed");
  const sid = cookieValue(request);
  if (!validSid(sid)) throw fail(400, "oauth_state_invalid", "T3 sign-in could not be completed");
  const stub = await storeFor(identity, env, sid);
  const browserSession = await storeCall(stub, "read", { sid, subject: identity.sub });
  if (browserSession.sid !== sid) throw fail(400, "oauth_state_invalid", "T3 sign-in could not be completed");
  const consumed = await storeCall(stub, "consume", { state, sid, subject: identity.sub });
  const pending = consumed.pending;
  if (!pending || pending.expiresAt <= Date.now() || pending.issuer !== T3_ISSUER || pending.subject !== identity.sub || pending.callback !== `${origin}/api/t3/auth/callback`) throw fail(400, "oauth_state_invalid", "T3 sign-in could not be completed");
  if (oauthError) return new Response(null, { status: 303, headers: { location: `${origin}/?t3=error&reason=oauth_denied`, "cache-control": "no-store", "set-cookie": cookieHeader(sid) } });
  const response = await tokenFetch(fetcher, TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: pending.callback, client_id: pending.clientId, code_verifier: pending.verifier, resource: RESOURCE }) });
  const token = await safeJson(response);
  if (!token || token.token_type?.toLowerCase() !== "bearer" || typeof token.access_token !== "string" || !token.access_token || token.scope !== SCOPE || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    await storeCall(stub, "clear", { sid: pending.sid, subject: identity.sub });
    throw fail(403, "t3_scope_rejected", "T3 did not grant exactly read-only access; no session was saved");
  }
  await storeCall(stub, "connect", { subject: identity.sub, sid: pending.sid, accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 });
  return new Response(null, { status: 303, headers: { location: `${origin}/?t3=connected&repoId=R_kgDOUSfguQ`, "cache-control": "no-store", "set-cookie": cookieHeader(pending.sid, Math.min(token.expires_in, 30 * 86400)) } });
}

export class T3AuthStore {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/state") return new Response(null, { status: 404 });
    const action = request.headers.get("x-t3-store-action");
    if (!new Set(["begin", "consume", "connect", "read", "clear"]).has(action)) return new Response(null, { status: 400 });
    let data;
    try { data = JSON.parse(await readLimited(request)); } catch { return new Response(null, { status: 400 }); }
    const now = Date.now();
    if (action === "begin" && (!data || typeof data.state !== "string" || data.state.length > 128 || typeof data.verifier !== "string" || data.verifier.length < 43 || data.verifier.length > 128 || !validSid(data.sid) || typeof data.subject !== "string" || !data.subject || data.subject.length > 512 || typeof data.clientId !== "string" || !data.clientId || data.clientId.length > 512 || data.issuer !== T3_ISSUER || typeof data.callback !== "string" || data.callback.length > 2048 || !Number.isFinite(data.expiresAt) || data.expiresAt <= now || data.expiresAt > now + 6 * 60_000)) return new Response(null, { status: 400 });
    if (action === "consume" && (!data || typeof data.state !== "string" || !validSid(data.sid) || typeof data.subject !== "string" || data.state.length > 128 || data.subject.length > 512)) return new Response(null, { status: 400 });
    if (action === "connect" && (!data || typeof data.subject !== "string" || !data.subject || data.subject.length > 512 || !validSid(data.sid) || typeof data.accessToken !== "string" || !data.accessToken || data.accessToken.length > 4_000 || /[\u0000-\u001f]/.test(data.accessToken) || !Number.isFinite(data.expiresAt) || data.expiresAt <= now || data.expiresAt > now + 366 * 86400_000)) return new Response(null, { status: 400 });
    const result = {};
    await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get("record") || {};
      const now = Date.now();
      if (record.pending?.expiresAt <= now) delete record.pending;
      if (record.session?.expiresAt <= now) delete record.session;
      if (record.csrf?.expiresAt <= now) delete record.csrf;
      if (action === "begin") { record.pending = data; }
      else if (action === "consume") {
        const pending = record.pending;
        if (pending?.expiresAt <= now) delete record.pending;
        else if (pending?.state === data.state && pending?.sid === data.sid && pending?.subject === data.subject) {
          result.pending = pending;
          delete record.pending;
        }
      } else if (action === "connect") { record.session = { ...data, connectedAt: now }; }
      else if (action === "read") {
        if (!data || !validSid(data.sid) || typeof data.subject !== "string") return;
        if (!record.csrf || record.csrf.sid !== data.sid || record.csrf.expiresAt <= now) record.csrf = { sid: data.sid, subject: data.subject, token: random(32), expiresAt: now + 30 * 86400_000 };
        result.session = record.session?.sid === data.sid && record.session?.subject === data.subject ? record.session : null;
        result.csrf = record.csrf.subject === data.subject ? record.csrf.token : null;
        result.sid = data.sid;
      }
      else if (action === "clear") {
        if (record.session?.sid === data.sid && record.session?.subject === data.subject) delete record.session;
        if (record.pending?.sid === data.sid && record.pending?.subject === data.subject) delete record.pending;
        if (record.csrf?.sid === data.sid && record.csrf?.subject === data.subject) delete record.csrf;
      }
      else throw new Error("action");
      if (record.pending || record.session || record.csrf) await txn.put("record", record); else await txn.delete("record");
    });
    return json(result || {});
  }
}

async function mcpRequest(fetcher, token, method, params, session) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": session.version || "2025-06-18" };
  if (session.id) headers["mcp-session-id"] = session.id;
  let response;
  const notification = method.startsWith("notifications/");
  const requestId = notification ? null : crypto.randomUUID();
  try { response = await fixedFetch(fetcher, MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(requestId ? { id: requestId } : {}), method, ...(params === undefined ? {} : { params }) }) }); }
  catch { throw fail(502, "t3_unavailable", "T3 conversations could not be loaded"); }
  if (response.status === 401) throw fail(401, "t3_session_expired", "T3 sign-in expired; disconnect and reconnect");
  if (!response.ok) throw fail(502, "t3_unavailable", "T3 conversations could not be loaded");
  if (notification && [202, 204].includes(response.status)) return null;
  const type = response.headers.get("content-type") || "";
  let text = "";
  const reader = response.body?.getReader();
  if (reader) {
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw fail(502, "t3_response_too_large", "T3 returned too much conversation data"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    text = new TextDecoder().decode(bytes);
  }
  if (notification && !text) return null;
  const responseSession = response.headers.get("mcp-session-id");
  if (responseSession) {
    if (responseSession.length > 512 || /[\u0000-\u001f]/.test(responseSession)) throw fail(502, "t3_response_invalid", "T3 returned an invalid conversation response");
    session.id = responseSession;
  }
  const version = response.headers.get("mcp-protocol-version");
  if (version && version !== "2025-06-18") throw fail(502, "t3_version_unsupported", "T3 returned an unsupported conversation protocol version");
  let payload;
  try {
    if (type.includes("text/event-stream")) {
      const events = [];
      let dataLines = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line) {
          if (dataLines.length) events.push(dataLines.join("\n"));
          dataLines = [];
        } else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length) events.push(dataLines.join("\n"));
      const correlated = events.map((data) => { try { return JSON.parse(data); } catch { return null; } })
        .filter((event) => event && (notification || event.id === requestId));
      if (correlated.length !== 1) throw new Error("missing or duplicate correlated event");
      payload = correlated[0];
    } else payload = JSON.parse(text);
  } catch { throw fail(502, "t3_response_invalid", "T3 returned an invalid conversation response"); }
  if (!notification && payload?.id !== requestId) throw fail(502, "t3_response_invalid", "T3 returned an invalid conversation response");
  if (payload?.error) throw fail(502, "t3_unavailable", "T3 conversations could not be loaded");
  return payload?.result;
}

async function tool(fetcher, token, session, name, args) {
  const result = await mcpRequest(fetcher, token, "tools/call", { name, arguments: args }, session);
  if (!result || result.isError) throw fail(502, "t3_unavailable", "T3 conversations could not be loaded");
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((x) => x.type === "text")?.text;
  if (typeof text === "string") { try { return JSON.parse(text); } catch { /* return text for safe normalizer */ } }
  return result;
}

function normalizedProject(value, mapping) {
  const p = value?.project || value;
  const repo = p?.repositoryIdentity;
  if (!p || p.id !== mapping.projectId || p.workspaceRoot !== "/projects/glb-viewer" || (repo != null && (typeof repo !== "object" || repo.canonicalKey !== "github.com/swamp2k/glb-viewer" || repo.rootPath !== "/projects/glb-viewer"))) throw fail(403, "project_mismatch", "The T3 project identity did not match the configured repository");
  return { id: mapping.projectId, workspaceRoot: mapping.workspaceRoot };
}

function extractThreads(value) {
  const envelope = value?.projectId ? value : value?.result?.projectId ? value.result : value;
  const threads = Array.isArray(envelope) ? envelope : envelope?.threads || envelope?.items || envelope?.data || [];
  if (!Array.isArray(threads)) throw fail(502, "t3_response_invalid", "T3 returned an invalid conversation list");
  return { threads, nextCursor: Number.isSafeInteger(envelope?.nextCursor) && envelope.nextCursor >= 0 ? envelope.nextCursor : null, total: Number.isSafeInteger(envelope?.total) && envelope.total >= 0 ? envelope.total : null, truncated: threads.length > MAX_THREADS };
}
function normalizeThread(raw, projectId) {
  const thread = raw?.thread || raw;
  const id = thread?.threadId ?? thread?.id;
  if (!thread || typeof id !== "string" || !id || thread.projectId !== projectId) throw fail(403, "thread_mismatch", "The T3 conversation did not belong to this project");
  return { id, title: typeof thread.title === "string" ? thread.title.slice(0, 500) : "Conversation", ...(typeof thread.status === "string" ? { status: thread.status.slice(0, 100) } : {}), createdAt: thread.createdAt || null, updatedAt: thread.updatedAt || null, projectId };
}
function normalizeItem(item) {
  const source = typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
  return { type: typeof item.type === "string" ? item.type.slice(0, 100) : "unknown", createdBy: typeof item.createdBy === "string" ? item.createdBy.slice(0, 80) : "unknown", text: source.slice(0, MAX_ITEM_CHARS), textTruncated: item.textTruncated === true || source.length > MAX_ITEM_CHARS, at: item.createdAt || item.updatedAt || null };
}

export async function liveRead(request, env, identity, repo, fetcher = fetch) {
  const canonical = canonicalRepo(repo);
  const map = JSON.parse(env.T3_PROJECTS_JSON || "[]");
  if (!Array.isArray(map) || map.length !== 1) throw fail(503, "mapping_unavailable", "The verified T3 project mapping is unavailable");
  const matches = map.filter((m) => m?.repoId === canonical.id);
  if (matches.length !== 1) throw fail(503, "mapping_unavailable", "No unique verified T3 project mapping exists for this repository");
  const mapping = matches[0];
  if (canonical.id !== "R_kgDOUSfguQ" || canonical.owner !== "swamp2k" || canonical.name !== "glb-viewer" || mapping.owner !== canonical.owner || mapping.name !== canonical.name || mapping.projectId !== "mcp:6ccdf28e-d941-4b71-a636-a344020b5643" || mapping.workspaceRoot !== "/projects/glb-viewer") throw fail(403, "project_mismatch", "Only the verified glb-viewer T3 project is available");
  const stub = await storeFor(identity, env, cookieValue(request));
  const record = await storeCall(stub, "read", { sid: cookieValue(request), subject: identity.sub });
  const access = parseCookieSession(request, identity, record);
  const mcpSession = { version: "2025-06-18" };
  const init = await mcpRequest(fetcher, access.accessToken, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repo-board", version: "1" } }, mcpSession);
  if (!init || init.protocolVersion !== "2025-06-18") throw fail(502, "t3_version_unsupported", "T3 returned an unsupported conversation protocol version");
  await mcpRequest(fetcher, access.accessToken, "notifications/initialized", undefined, mcpSession);
  const projectData = await tool(fetcher, access.accessToken, mcpSession, "t3_project_read", { projectId: mapping.projectId });
  const project = normalizedProject(projectData, mapping);
  const cursorValue = new URL(request.url).searchParams.get("cursor");
  const requestedCursor = cursorValue === null ? undefined : Number(cursorValue);
  if (cursorValue !== null && (!/^\d{1,8}$/.test(cursorValue) || !Number.isSafeInteger(requestedCursor))) throw fail(400, "invalid_conversation_page", "Conversation page is invalid");
  const listed = await tool(fetcher, access.accessToken, mcpSession, "t3_thread_list", { projectId: mapping.projectId, limit: MAX_THREADS, ...(requestedCursor !== undefined ? { cursor: requestedCursor } : {}) });
  const page = extractThreads(listed);
  const threads = page.threads.slice(0, MAX_THREADS).map((raw) => normalizeThread(raw, mapping.projectId));
  const requested = new URL(request.url).searchParams.get("threadId");
  let selected = null;
  if (requested) {
    if (requested.length > 512) throw fail(400, "invalid_conversation", "Conversation id is invalid");
    if (!threads.some((x) => x.id === requested)) throw fail(404, "conversation_not_found", "Conversation does not belong to this repository");
    const positionValue = new URL(request.url).searchParams.get("position");
    const position = Number(positionValue || 0);
    if (!Number.isSafeInteger(position) || position < 0 || position > 10_000_000) throw fail(400, "invalid_conversation_page", "Conversation page is invalid");
    const details = await tool(fetcher, access.accessToken, mcpSession, "t3_thread_read", { threadId: requested, view: "messages", limit: MAX_ITEMS, maxCharsPerItem: MAX_ITEM_CHARS, ...(positionValue !== null ? { afterPosition: position } : {}) });
    const raw = details?.thread || details;
    const normalized = normalizeThread(raw, mapping.projectId);
    if (normalized.id !== requested) throw fail(403, "thread_mismatch", "The T3 conversation did not belong to this project");
    const items = Array.isArray(details?.items) ? details.items : [];
    selected = { ...normalized, items: items.slice(0, MAX_ITEMS).map(normalizeItem), itemsTruncated: items.length > MAX_ITEMS, nextPosition: Number.isSafeInteger(details?.nextPosition) ? details.nextPosition : null, hasMore: details?.hasMore === true || items.length > MAX_ITEMS, view: "messages" };
  }
  return json({ mode: "live-read-only", project, conversations: threads, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null || page.truncated, truncated: page.truncated, total: page.total, selected });
}

export async function handleT3AuthRequest(request, env, options = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/t3/auth/")) return null;
  try {
    if (env.T3_MODE !== "live") throw fail(503, "t3_disabled", "Native T3 sign-in is disabled");
    if (!env.T3_AUTH_STORE) throw fail(503, "auth_store_unavailable", "T3 sign-in storage is unavailable");
    boardOrigin(env, request);
    const identity = await (options.authenticate || (async () => { throw fail(503, "auth_not_configured", "Board identity verification is unavailable"); }))(request, env, options.fetcher);
    if (["/api/t3/auth/start", "/api/t3/auth/callback", "/api/t3/auth/disconnect", "/api/t3/auth/session"].includes(url.pathname) && env.T3_MODE === "live") {
      if (typeof options.rateLimit !== "function") throw fail(503, "rate_limiter_unavailable", "T3 rate limiting is unavailable");
      await options.rateLimit(identity);
    }
    const fetcher = options.fetcher || fetch;
    if (url.pathname === "/api/t3/auth/start" && request.method === "POST") return await begin(request, env, identity, fetcher);
    if (url.pathname === "/api/t3/auth/callback" && request.method === "GET") return await callback(request, env, identity, fetcher);
    if (url.pathname === "/api/t3/auth/disconnect" && request.method === "POST") {
      const origin = boardOrigin(env, request);
      if (request.headers.get("origin") !== origin || request.headers.get("x-repo-board-request") !== "1" || !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw fail(403, "csrf_rejected", "Request could not be verified");
      const body = await readLimited(request).then((text) => JSON.parse(text)).catch(() => null);
      const sid = cookieValue(request);
      if (!validSid(sid)) throw fail(401, "t3_not_connected", "Connect to T3 to read conversations");
      const stub = await storeFor(identity, env, sid);
      const browserSession = await storeCall(stub, "read", { sid, subject: identity.sub });
      if (!body || browserSession.csrf !== body.csrf || body.csrf !== request.headers.get("x-repo-board-csrf") || !cookieValue(request) || cookieValue(request) !== browserSession.sid) throw fail(403, "csrf_rejected", "Request could not be verified");
      await storeCall(stub, "clear", { sid, subject: identity.sub });
      return json({ connected: false }, 200, { "set-cookie": cookieHeader("", 0) });
    }
    if (url.pathname === "/api/t3/auth/session" && request.method === "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== boardOrigin(env, request)) throw fail(403, "origin_rejected", "Request origin is not allowed");
      if (request.headers.get("x-repo-board-request") !== "1") throw fail(403, "csrf_rejected", "Request could not be verified");
      const suppliedSid = cookieValue(request);
      const sid = validSid(suppliedSid) ? suppliedSid : random(32);
      const stub = await storeFor(identity, env, sid);
      const record = await storeCall(stub, "read", { sid, subject: identity.sub });
      const session = record.session;
      return json({ connected: !!session && session.subject === identity.sub && session.sid === sid && session.expiresAt > Date.now(), csrf: record.csrf }, 200, { "set-cookie": cookieHeader(sid, 30 * 86400) });
    }
    throw fail(404, "not_found", "Not found");
  } catch (e) {
    const err = e instanceof T3Error ? e : fail(502, "t3_unavailable", "T3 service is temporarily unavailable");
    if (request.method === "GET" && url.pathname.endsWith("/callback")) {
      const origin = (() => { try { return new URL(env.BOARD_ORIGIN).origin; } catch { return "/"; } })();
      return new Response(null, { status: 303, headers: { location: `${origin}/?t3=error&reason=${encodeURIComponent(err.code)}`, "cache-control": "no-store" } });
    }
    return json({ error: { code: err.code, message: err.message } }, err.status);
  }
}

export const T3_COOKIE_NAME = COOKIE;
