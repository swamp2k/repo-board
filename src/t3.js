// Optional T3 session API. This is deliberately a mock-only adapter: no live
// agent, repository, or project endpoint is assumed or called.
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const KEY_PREFIX = "t3:mock:v1:";

export function parseRepositories(value) {
  let entries;
  try { entries = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error("invalid_repository_configuration"); }
  if (!Array.isArray(entries)) throw new Error("invalid_repository_configuration");
  const seen = new Set(); const names = new Set(); const projects = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.githubId) || entry.githubId < 1 ||
      typeof entry.owner !== "string" || typeof entry.repo !== "string" || typeof entry.projectId !== "string" ||
      typeof entry.workspace !== "string" || entry.verified !== true ||
      !/^[A-Za-z0-9_.-]+$/.test(entry.owner) || !/^[A-Za-z0-9_.-]+$/.test(entry.repo) ||
      !entry.projectId || !entry.workspace) throw new Error("invalid_repository_configuration");
    const canonical = `${entry.owner}/${entry.repo}`.toLowerCase();
    if (seen.has(entry.githubId) || names.has(canonical) || projects.has(entry.projectId)) throw new Error("invalid_repository_configuration");
    seen.add(entry.githubId); names.add(canonical); projects.add(entry.projectId);
    return { githubId: entry.githubId, owner: entry.owner, repo: entry.repo, projectId: entry.projectId, workspace: entry.workspace, verified: true };
  });
}

export class MockT3Adapter {
  constructor(store) { this.store = store; }
  async list(repo) { return this.#load(repo); }
  async create(repo, prompt, requestId) {
    const data = await this.#load(repo);
    const existing = data.sessions.find(s => s.requestId === requestId);
    if (existing) return existing;
    if (data.sessions.length >= 50) throw new Error("mock_limit");
    const id = `mock-${crypto.randomUUID()}`;
    const session = { id, requestId, title: prompt.slice(0, 72) || `Inspection: ${repo.owner}/${repo.repo}`, status: "completed", messages: [{ role: "user", content: prompt }, { role: "assistant", content: "[SIMULATED] Read-only inspection session created. No agent was started and no repository was accessed." }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    data.sessions.unshift(session);
    await this.#save(repo, data);
    return session;
  }
  async send(repo, id, text) {
    const data = await this.#load(repo); const session = data.sessions.find((s) => s.id === id);
    if (!session) return null;
    if (session.status === "stopped") return { error: "session_not_running" };
    if (session.messages.length >= 100) return { error: "mock_message_limit" };
    session.messages.push({ role: "user", content: text });
    session.messages.push({ role: "assistant", content: "[SIMULATED] Message recorded for the demo. No agent was started." });
    session.updatedAt = new Date().toISOString(); await this.#save(repo, data); return session;
  }
  async stop(repo, id) {
    const data = await this.#load(repo); const session = data.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.status = "stopped"; session.updatedAt = new Date().toISOString(); await this.#save(repo, data); return session;
  }
  async #load(repo) {
    const key = KEY_PREFIX + repo.githubId;
    const data = await this.store.get(key, "json");
    return data && Array.isArray(data.sessions) ? data : { sessions: [] };
  }
  async #save(repo, value) { await this.store.put(KEY_PREFIX + repo.githubId, JSON.stringify(value)); }
}

function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS }); }
function validOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
async function body(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return null;
  if (Number(request.headers.get("content-length")) > 12000) return null;
  try {
    const reader = request.body?.getReader(); if (!reader) return null;
    const chunks = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 12000) { await reader.cancel(); return null; } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export async function handleT3Request(request, env) {
  if (env.T3_MODE !== "mock") return response({ error: "t3_disabled" }, 503);
  if (!env.T3_API_TOKEN || request.headers.get("authorization") !== `Basic ${btoa(`demo:${env.T3_API_TOKEN}`)}`) return new Response(JSON.stringify({ error: "unauthorized", mode: "mock" }), { status: 401, headers: { ...JSON_HEADERS, "www-authenticate": 'Basic realm="Repo Board mock demo", charset="UTF-8"' } });
  if (!env.T3_STORE || typeof env.T3_STORE.get !== "function" || typeof env.T3_STORE.put !== "function") return response({ error: "mock_store_unavailable" }, 503);
  let repos;
  try { repos = parseRepositories(env.T3_REPOSITORIES); } catch { return response({ error: "invalid_repository_configuration" }, 503); }
  const url = new URL(request.url); const segments = url.pathname.split("/").filter(Boolean).slice(2);
  const method = request.method.toUpperCase();
  if (method !== "GET") {
    if (!validOrigin(request)) return response({ error: "origin_denied" }, 403);
    if (request.headers.get("x-t3-request") !== "1") return response({ error: "custom_header_required" }, 403);
  }
  const repoId = Number(segments[0]);
  const repo = repos.find((item) => item.githubId === repoId);
  if (!repo) return response({ error: "repository_not_allowed" }, 404);
  const sessionId = segments[1]; const adapter = new MockT3Adapter(env.T3_STORE);
  try {
    if (method === "GET" && segments.length === 1) return response({ mode: "mock", repository: { githubId: repo.githubId, name: `${repo.owner}/${repo.repo}` }, sessions: await adapter.list(repo).then((d) => d.sessions) });
    if (method === "POST" && segments.length === 1) {
      const input = await body(request);
      if (!input || Object.keys(input).some(k => !["prompt", "requestId"].includes(k)) || typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId) || typeof input.prompt !== "string" || input.prompt.length > 8000) return response({ error: "invalid_prompt" }, 400);
      return response({ mode: "mock", session: await adapter.create(repo, input.prompt, input.requestId) }, 201);
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "messages") {
      const input = await body(request);
      if (!input || Object.keys(input).some(k => k !== "text") || typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000) return response({ error: "invalid_message" }, 400);
      const result = await adapter.send(repo, sessionId, input.text);
      if (!result) return response({ error: "session_not_found" }, 404);
      if (result.error) return response({ error: result.error }, 409);
      return response({ mode: "mock", session: result });
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "stop") {
      const result = await adapter.stop(repo, sessionId);
      return result ? response({ mode: "mock", session: result }) : response({ error: "session_not_found" }, 404);
    }
    return response({ error: "not_found" }, 404);
  } catch { return response({ error: "mock_store_error" }, 503); }
}
