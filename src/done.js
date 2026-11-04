// "Mark done" button: sets `Next step: Done` (and `Updated:`) in one repo's NOW.md with a single small commit.
// Guarded by: Cloudflare Access identity + DONE_EMAILS allowlist + exact board Origin + custom header.
const OWNER = "swamp2k";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (status, code, message, extra = {}) => new Response(JSON.stringify(status < 400 ? { ok: true, ...extra } : { error: { code, message } }), { status, headers: JSON_HEADERS });

// Line-based so markdown labels work too ("**Next step:** x", "- Next step: x").
// The first matching line is rewritten (keeping its label style); later duplicates are removed.
export function markDone(text, today) {
  const label = (name) => new RegExp(`^(\\s*(?:[-*]\\s+)?(?:\\*\\*|__)?${name}(?:\\*\\*|__)?\\s*:(?:\\*\\*|__)?)`, "i");
  const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  for (const [name, value] of [["Next step", "Done"], ["Updated", today]]) {
    const re = label(name);
    let seen = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      if (!seen) { lines[i] = `${m[1]} ${value}`; seen = true; } else { lines.splice(i, 1); i--; }
    }
    if (!seen) lines.push("", `${name}: ${value}`);
  }
  return lines.join("\n") + "\n";
}

const toBase64 = (text) => { const bytes = new TextEncoder().encode(text); let bin = ""; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(bin); };
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

export async function handleDone(request, env, { authenticate, fetcher = fetch, now = () => new Date() } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/done") return null;
  if (request.method !== "POST") return reply(405, "method_not_allowed", "Use the Mark done button");
  try { new URL(env.BOARD_ORIGIN || ""); } catch { return reply(503, "not_configured", "Mark done is not configured"); }
  if (request.headers.get("origin") !== new URL(env.BOARD_ORIGIN).origin || request.headers.get("x-repo-board-request") !== "1" || !/^application\/json/i.test(request.headers.get("content-type") || "")) return reply(403, "request_rejected", "Request could not be verified");
  let identity;
  try { identity = await authenticate(request, env); } catch { return reply(401, "unauthorized", "A valid Cloudflare Access session is required"); }
  const allowed = String(env.DONE_EMAILS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  if (!identity?.email || !allowed.includes(String(identity.email).toLowerCase())) return reply(403, "not_allowed", "Your account may look at the board but not change repositories");
  if (!env.GITHUB_TOKEN) return reply(503, "not_configured", "GitHub token is not set");
  const raw = await request.text();
  if (raw.length > 1000) return reply(413, "too_large", "Request is too large");
  let name;
  try { name = JSON.parse(raw)?.name; } catch { /* handled below */ }
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") return reply(400, "invalid_repo", "Repository name is invalid");
  const api = `https://api.github.com/repos/${OWNER}/${name}/contents/NOW.md`;
  const headers = { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "repo-board", "x-github-api-version": "2022-11-28" };
  let file;
  try {
    const got = await fetcher(api, { headers, signal: AbortSignal.timeout(8_000) });
    if (got.status === 404) return reply(404, "no_now_md", "This repository has no NOW.md");
    if (!got.ok) return reply(502, "github_unavailable", `GitHub answered HTTP ${got.status} when reading NOW.md`);
    file = await got.json();
  } catch { return reply(502, "github_unavailable", "Could not reach GitHub"); }
  if (typeof file?.content !== "string" || typeof file?.sha !== "string" || file.encoding !== "base64") return reply(502, "github_unavailable", "GitHub returned an unexpected NOW.md");
  const before = fromBase64(file.content);
  const today = now().toISOString().slice(0, 10);
  const after = markDone(before, today);
  if (after === before) return reply(200, "", "", { unchanged: true });
  try {
    const put = await fetcher(api, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ message: "Mark done in NOW.md (via Repo Board)", content: toBase64(after), sha: file.sha }), signal: AbortSignal.timeout(8_000) });
    if (put.status === 401 || put.status === 403) return reply(403, "github_no_write", "The GitHub token cannot write to this repository (or the branch is protected). Use the copied prompt instead");
    if (put.status === 409 || put.status === 422) return reply(409, "github_conflict", "NOW.md changed or the branch is protected. Refresh and try again, or use the copied prompt");
    if (!put.ok) return reply(502, "github_unavailable", `GitHub answered HTTP ${put.status} when saving NOW.md`);
  } catch { return reply(502, "github_unavailable", "Could not reach GitHub"); }
  return reply(200, "", "", { done: true });
}
