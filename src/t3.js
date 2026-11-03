// Mock first T3 adapter. Live transport deliberately fails closed until its
// endpoint, authentication contract, and project mappings have been verified.
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BODY = 8_192;
const REPO_ID = /^[A-Za-z0-9_+/=-]{1,128}$/;
const OWNER_NAME = /^[^/\\\u0000-\u001f]{1,100}$/;

export class T3Error extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function canonicalRepo(repo) {
  const owner = repo.owner?.login;
  if (!REPO_ID.test(repo.id || "") || !OWNER_NAME.test(owner || "") || !OWNER_NAME.test(repo.name || "")) {
    throw new T3Error(400, "invalid_repository", "Repository identity is invalid");
  }
  let url, segments;
  try { url = new URL(repo.url); segments = url.pathname.split("/").slice(1).map(decodeURIComponent); } catch { throw new T3Error(400, "invalid_repository", "Repository identity is invalid"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || segments.length !== 2 || segments[0] !== owner || segments[1] !== repo.name || url.search || url.hash) throw new T3Error(400, "invalid_repository", "Repository identity is invalid");
  return { id: repo.id, owner, name: repo.name, fullName: `${owner}/${repo.name}`, url: url.href };
}

export function resolveProject(repo, env) {
  const identity = canonicalRepo(repo);
  const mode = env.T3_MODE;
  if (mode === "mock") return { ...identity, mode, projectId: `mock-project-${identity.id}`, workspaceRoot: `/mock/${identity.owner}/${identity.name}` };
  if (mode !== "live") throw new T3Error(503, "t3_disabled", "T3 integration is disabled");
  let list;
  try { list = JSON.parse(env.T3_PROJECTS_JSON || ""); } catch { throw new T3Error(503, "mapping_unavailable", "Live project mappings are unavailable"); }
  if (!Array.isArray(list)) throw new T3Error(503, "mapping_unavailable", "Live project mappings are unavailable");
  const matches = list.filter((m) => m?.repoId === identity.id);
  if (matches.length !== 1) throw new T3Error(503, "mapping_unavailable", "No unique verified project mapping exists for this repository");
  const m = matches[0];
  if (m.owner !== identity.owner || m.name !== identity.name || typeof m.projectId !== "string" || !m.projectId || m.projectId.length > 200 || /[\u0000-\u001f]/.test(m.projectId) || typeof m.workspaceRoot !== "string" || !m.workspaceRoot.startsWith("/") || m.workspaceRoot.startsWith("//") || m.workspaceRoot.includes("\\") || m.workspaceRoot.length > 512 || /[\u0000-\u001f]/.test(m.workspaceRoot) || m.workspaceRoot.split("/").some((part) => part === "." || part === "..")) {
    throw new T3Error(503, "mapping_stale", "The configured project mapping does not match the current GitHub repository identity");
  }
  if (list.some((other) => other !== m && (other?.projectId === m.projectId || other?.workspaceRoot === m.workspaceRoot))) {
    throw new T3Error(503, "mapping_ambiguous", "A T3 project or workspace is mapped to more than one repository");
  }
  throw new T3Error(503, "live_transport_unavailable", "Live T3 transport is not configured: the verified remote API and authentication contract are still pending");
}

function decodeBase64Url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verifyAccess(request, env, fetcher = fetch) {
  const domain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  const allowedEmails = (env.ACCESS_ALLOWED_EMAILS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const allowedSubs = (env.ACCESS_ALLOWED_SUBJECTS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!domain || !aud || (!allowedEmails.length && !allowedSubs.length)) throw new T3Error(503, "auth_not_configured", "T3 API authorization is not configured");
  let u;
  try { u = new URL(domain); } catch { throw new T3Error(503, "auth_not_configured", "T3 API authorization is not configured"); }
  if (u.protocol !== "https:" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(u.hostname) || u.pathname !== "/" || u.search || u.hash) throw new T3Error(503, "auth_not_configured", "T3 API authorization is not configured");
  const issuer = u.origin;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 12_000) throw new T3Error(401, "unauthorized", "A valid Cloudflare Access session is required");
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("format");
    const [h, p, sig] = parts;
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(h)));
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(p)));
    if (!h || !p || !sig || header.alg !== "RS256" || !header.kid || typeof claims.sub !== "string" || !claims.sub || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat)) throw new Error("claims");
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now || claims.iat > now + 60 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now)) || claims.iss !== issuer || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud)) throw new Error("claims");
    const jwks = await fetcher(`${issuer}/cdn-cgi/access/certs`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3_000) });
    if (!jwks.ok) throw new Error("keys");
    const keys = await jwks.json();
    const jwk = keys.keys?.find((k) => k.kid === header.kid && k.kty === "RSA" && (k.use === undefined || k.use === "sig") && (k.alg === undefined || k.alg === "RS256"));
    if (!jwk) throw new Error("key");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw new Error("signature");
    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
    if (!(allowedSubs.includes(claims.sub) || (email && allowedEmails.includes(email)))) throw new Error("identity");
    return { sub: claims.sub, email };
  } catch {
    throw new T3Error(401, "unauthorized", "A valid Cloudflare Access session is required");
  }
}

function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS }); }

async function readLimited(request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new T3Error(413, "request_too_large", "Request is too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function handleT3Request(request, env, options = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/t3")) return null;
  try {
    if (url.pathname !== "/api/t3" || !["GET", "POST"].includes(request.method)) throw new T3Error(404, "not_found", "Not found");
    const auth = options.authenticate || verifyAccess;
    await auth(request, env, options.fetcher);
    const expectedOrigin = url.origin;
    const origin = request.headers.get("origin");
    if ((origin && origin !== expectedOrigin) || (request.method === "POST" && origin !== expectedOrigin)) throw new T3Error(403, "origin_rejected", "Request origin is not allowed");
    if (request.method === "POST" && request.headers.get("x-repo-board-request") !== "1") throw new T3Error(403, "csrf_rejected", "Request could not be verified");
    if (request.method === "POST" && !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new T3Error(415, "content_type_rejected", "JSON content type is required");
    const repoId = url.searchParams.get("repoId");
    if (!REPO_ID.test(repoId || "")) throw new T3Error(400, "invalid_repository", "Repository identity is invalid");
    const repo = await options.findRepo?.(repoId);
    if (!repo) throw new T3Error(404, "repository_not_found", "Repository was not found");
    if (env.T3_MODE === "live") resolveProject(repo, env);
    if (env.T3_MODE !== "mock") throw new T3Error(503, "t3_disabled", "T3 integration is disabled");
    const project = resolveProject(repo, env);
    if (request.method === "GET") {
      return json({ mock: true, project, conversations: [], activity: [{ at: new Date().toISOString(), text: "Mock workspace ready; no T3 request was sent." }] });
    }
    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_BODY) throw new T3Error(413, "request_too_large", "Request is too large");
    const bodyText = await readLimited(request);
    let body;
    try { body = JSON.parse(bodyText); } catch { throw new T3Error(400, "invalid_request", "Request body is invalid"); }
    if (!body || !["list", "new", "send", "resume", "cancel"].includes(body.action)) throw new T3Error(400, "invalid_request", "Request action is invalid");
    if (body.action === "list") return json({ mock: true, project, conversations: [], activity: [{ at: new Date().toISOString(), text: "Mock workspace checked; no T3 request was sent." }] });
    if (body.action === "new") {
      if (typeof body.requestId !== "string" || !/^[a-f0-9-]{16,80}$/i.test(body.requestId)) throw new T3Error(400, "invalid_request", "Request id is invalid");
      if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 4_000) throw new T3Error(400, "invalid_request", "Initial inspection prompt is invalid");
      return json({ mock: true, project, thread: { id: `mock:${repoId}:${body.requestId}`, title: body.prompt.trim().split(/\s+/).slice(0, 8).join(" "), status: "waiting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [{ role: "user", text: body.prompt }, { role: "assistant", text: "Mock conversation created and waiting. No agent was launched." }] } });
    }
    if (typeof body.threadId !== "string" || !body.threadId.startsWith(`mock:${repoId}:`)) throw new T3Error(404, "conversation_not_found", "Conversation does not belong to this repository");
    if (body.action === "send" && (typeof body.text !== "string" || !body.text.trim() || body.text.length > 4_000)) throw new T3Error(400, "invalid_request", "Follow-up must be 1 to 4000 characters");
    const status = body.action === "cancel" ? "cancelled" : body.action === "resume" ? "running" : "waiting";
    const text = body.action === "send" ? "Mock follow-up recorded and waiting. No message was sent to T3." : body.action === "resume" ? "Mock simulation running. No T3 thread was resumed." : "Mock simulation cancelled. No T3 thread was interrupted.";
    return json({ mock: true, project, thread: { id: body.threadId, status, updatedAt: new Date().toISOString(), message: text } });
  } catch (e) {
    const err = e instanceof T3Error ? e : new T3Error(502, "t3_unavailable", "T3 service is temporarily unavailable");
    return json({ error: { code: err.code, message: err.message } }, err.status);
  }
}
