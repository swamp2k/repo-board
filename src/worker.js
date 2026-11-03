// Repo Board — one card per GitHub repo, sorted into lanes from NOW.md + open PRs.
// One GitHub GraphQL call per page load (cached 60 s). Read-only.

const OWNER = "swamp2k";
const DAY = 86400000;

const QUERY = `query($login:String!){
  user(login:$login){
    repositories(first:100, ownerAffiliations:OWNER, orderBy:{field:PUSHED_AT,direction:DESC}){
      nodes{
        id databaseId name nameWithOwner url pushedAt isPrivate isArchived
        now: object(expression:"HEAD:NOW.md"){ ... on Blob { text } }
        pullRequests(states:OPEN, first:5, orderBy:{field:UPDATED_AT,direction:DESC}){
          totalCount nodes{ number title url updatedAt }
        }
      }
    }
  }
}`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/t3/")) return handleT3Request(request, env);
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });

    const cache = caches.default;
    const key = new Request(url.origin + "/__board", request);
    if (!env.T3_MODE && !url.searchParams.has("refresh")) {
      const hit = await cache.match(key);
      if (hit) return hit;
    }

    let repos;
    try {
      repos = await loadRepos(env.GITHUB_TOKEN);
    } catch (e) {
      return new Response(page(`<p class="err">Could not reach GitHub: ${esc(e.message)}</p>`), {
        status: 502, headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    let panel = "";
    if (env.T3_MODE === "mock") {
      try {
        const allowlist = parseRepositories(env.T3_REPOSITORIES).map((r) => {
          const boardRepo = repos.find((item) => item.databaseId === r.githubId);
          if (!boardRepo || boardRepo.nameWithOwner.toLowerCase() !== `${r.owner}/${r.repo}`.toLowerCase()) return null;
          return { githubId: r.githubId, name: boardRepo.nameWithOwner, url: boardRepo.url, now: parseNow(boardRepo.now?.text), inspectionPrompt: promptsFor(boardRepo, { safeInspection: true }).prompt };
        }).filter(Boolean);
        panel = t3ClientConfig(allowlist) + t3Panel();
      } catch { panel = t3ClientConfig([]) + t3Panel(); }
    }
    const res = new Response(page(renderBoard(repos, Date.now(), env.T3_MODE === "mock"), panel), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, max-age=60" },
    });
    if (!env.T3_MODE) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },
};

export async function loadRepos(token) {
  if (!token) throw new Error("GITHUB_TOKEN secret is not set");
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "user-agent": "repo-board", "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { login: OWNER } }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error(j.errors?.[0]?.message || `HTTP ${r.status}`);
  return j.data.user.repositories.nodes;
}

// Parse "Key: value" lines from NOW.md
export function parseNow(text) {
  if (!text) return null;
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(Doing|State|Next step|Blocked by|Updated|Epitaph)\s*:\s*(.+)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

const PR_STALE_DAYS = 14;

export function laneFor(repo, now) {
  if (repo.isArchived) return "graveyard";
  const days = Math.floor((now - Date.parse(repo.pushedAt)) / DAY);
  const prs = repo.pullRequests.nodes;
  if (prs.length) {
    const freshest = Math.max(...prs.map((p) => Date.parse(p.updatedAt)));
    return now - freshest <= PR_STALE_DAYS * DAY ? "review" : "decide";
  }
  if (repo.now) return days <= 14 ? "progress" : "paused";
  return days <= 30 ? "nobookmark" : "dusty";
}

const LANES = [
  ["decide", "Decide"],
  ["review", "Waiting for review"],
  ["progress", "In progress"],
  ["paused", "Paused"],
  ["nobookmark", "No bookmark yet"],
  ["dusty", "Gathering dust"],
  ["graveyard", "Graveyard"],
];
const CLOSED = new Set(["dusty", "graveyard"]);

export function renderBoard(repos, now, t3Enabled = false) {
  const groups = Object.fromEntries(LANES.map(([k]) => [k, []]));
  for (const r of repos) groups[laneFor(r, now)].push(r);

  return LANES.map(([k, title]) => {
    const items = groups[k];
    const body = items.map((r) => card(r, now, t3Enabled)).join("") || `<p class="empty">Nothing here</p>`;
    const open = CLOSED.has(k) ? "" : " open";
    return `<details class="lane lane-${k}"${open}><summary>${title} <span class="n">${items.length}</span></summary><div class="cards">${body}</div></details>`;
  }).join("");
}

// Plain data for Nexus (no HTML). Same lanes, same prompts as the web page.
export function buildBoard(repos, now) {
  return {
    contractVersion: 1,
    generatedAt: new Date(now).toISOString(),
    lanes: LANES.map(([id, title]) => ({
      id, title,
      repos: repos.filter((r) => laneFor(r, now) === id).map((r) => {
        const n = parseNow(r.now?.text) || {};
        const { prompt, retire } = promptsFor(r);
        return {
          name: r.name, url: r.url, isPrivate: r.isPrivate,
          daysSincePush: Math.floor((now - Date.parse(r.pushedAt)) / DAY),
          doing: n.doing ?? null, state: n.state ?? null, nextStep: n["next step"] ?? null,
          blockedBy: n["blocked by"] ?? null, epitaph: n.epitaph ?? null, hasNow: !!r.now,
          openPrs: r.pullRequests.totalCount,
          prs: r.pullRequests.nodes.map((p) => ({ number: p.number, title: p.title, url: p.url, daysSinceUpdate: Math.floor((now - Date.parse(p.updatedAt)) / DAY) })),
          resumePrompt: prompt, retirePrompt: retire,
        };
      }),
    })),
  };
}

function card(r, now, t3Enabled) {
  const days = Math.floor((now - Date.parse(r.pushedAt)) / DAY);
  const n = parseNow(r.now?.text);
  const dust = Math.min(days / 60, 1);
  const prList = r.pullRequests.nodes;
  const prs = prList.map((p) => {
    const age = Math.floor((now - Date.parse(p.updatedAt)) / DAY);
    return `<a class="pr" href="${esc(p.url)}">PR #${p.number}: ${esc(p.title)} <span class="muted">· ${age} d</span></a>`;
  }).join("");

  if (r.isArchived) {
    return `<article class="card grave">
      <header><a href="${esc(r.url)}">${esc(r.name)}</a></header>
      <div class="f muted">${n?.epitaph ? esc(n.epitaph) : "Rest in peace"}</div>
    </article>`;
  }

  const { prompt, retire } = promptsFor(r);
  const warn = prList.length
    ? `<div class="warn">${r.pullRequests.totalCount} open PR${r.pullRequests.totalCount > 1 ? "s" : ""}: decide before retiring</div>` : "";
  const fields = n
    ? ["doing", "state", "next step", "blocked by"]
        .filter((f) => n[f])
        .map((f) => `<div class="f"><b>${f[0].toUpperCase() + f.slice(1)}</b> ${esc(n[f])}</div>`).join("")
    : `<div class="f muted">No NOW.md yet</div>`;
  return `<article class="card" style="--dust:${dust.toFixed(2)}">
    <header><a href="${esc(r.url)}">${esc(r.name)}</a>${r.isPrivate ? `<span class="tag">private</span>` : ""}</header>
    ${fields}${prs}${warn}
    <footer><span class="age">${days === 0 ? "today" : days + " d ago"}</span>
    <span class="btns">${t3Enabled ? `<button type="button" data-t3-repo="${esc(r.databaseId)}" aria-haspopup="dialog">Run in T3</button>` : ""}<button class="ghost" data-p="${esc(retire)}" data-l="Retire">Retire</button>
    <button data-p="${esc(prompt)}" data-l="Copy prompt">Copy prompt</button></span></footer>
  </article>`;
}

export function promptsFor(r, options = {}) {
  const n = parseNow(r.now?.text);
  if (options.safeInspection) {
    return {
      prompt: `Inspect ${r.nameWithOwner || `${OWNER}/${r.name}`} (${r.url}) in read-only mode. Read AGENTS.md, CLAUDE.md, HANDOVER.md and NOW.md if present; inspect the README and relevant code. Inspect recent changes, preserve repository instructions, report uncertainties, summarize verified state and propose the next safe concrete action. Do not edit files, create projects, start agents, commit, push, merge, deploy, or change repository settings. No action beyond inspection is authorized.`,
      retire: "",
    };
  }
  const prompt = `Open ${OWNER}/${r.name} (${r.url}). Read AGENTS.md, CLAUDE.md and HANDOVER.md where present. First check the repository root for AGENTS.md and CLAUDE.md (exact uppercase filenames). If neither exists, create both with identical contents. If only one exists, copy its full contents to the other filename. If both exist and differ, explain the differences and propose a merged version preserving useful instructions; wait for my choice before changing either file or continuing implementation. If they are identical, keep them aligned. Preserve existing instructions and include these rules identically in both: read NOW.md at session start, update it before ending every session, and whenever either root instruction file changes, update both identically. Leave nested instruction files unchanged. ` + (r.now
    ? 'Read NOW.md and continue from "Next step". Update NOW.md before ending the session.'
    : 'Inspect the README, code, recent commits and open pull requests. Summarise the current state and suggest the next concrete action. Check whether NOW.md already exists in the repository root; read and update it if present, preserving relevant content, and create it only if missing. Use these fields: Doing, State, Next step, Blocked by, Updated (YYYY-MM-DD). Base it on verified findings; mark anything uncertain. Keep NOW.md current as work progresses. Commit and push the bookmark and instruction changes following the repository workflow (use a branch and PR if required), so they are available on GitHub. Present your findings and proposed next action, then wait for my direction before implementing further changes.');
  const retire = `Retire the repo ${OWNER}/${r.name}. First list its open pull requests and ask me what to do with each (merge, close, or leave) before doing anything. Then ask me for a one-line epitaph, write it to NOW.md as "Epitaph: <text>", commit, and archive the repo on GitHub.`;
  return { prompt, retire };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(inner, panel = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Repo Board</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--mut:#77756f;--line:#e3e1db;--acc:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#22221f;--ink:#ecebe6;--mut:#9a988f;--line:#33322e;--acc:#fb923c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}
h1{font-size:18px;margin:16px}h1 a{font-size:13px;color:var(--mut);margin-left:8px}
main{display:flex;gap:12px;overflow-x:auto;padding:0 16px 24px;align-items:flex-start}
.lane{flex:0 0 300px;background:color-mix(in srgb,var(--line) 40%,transparent);border-radius:10px;padding:8px}
summary{font-weight:600;cursor:pointer;padding:4px}.n{color:var(--mut);font-weight:400}
.cards{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;
 filter:saturate(calc(1 - var(--dust)*.8));opacity:calc(1 - var(--dust)*.4)}
.card header{display:flex;gap:6px;align-items:center;margin-bottom:4px}.card header a{font-weight:600;color:var(--ink)}
.tag{font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.f{font-size:13px;margin:2px 0}.f b{color:var(--mut);font-weight:500}.muted{color:var(--mut)}
.pr{display:block;font-size:13px;color:var(--acc);margin-top:4px}
.card footer{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:12px;color:var(--mut)}
button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.btns{display:flex;flex-wrap:wrap;gap:6px}.ghost{background:transparent;color:var(--mut);border:1px solid var(--line)}
.warn{font-size:12px;color:var(--acc);margin-top:6px}
dialog{width:min(680px,calc(100% - 24px));max-height:90vh;overflow:auto;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:20px}dialog::backdrop{background:#0009}.t3-mock{font-size:11px;color:#fff;background:#a33;padding:3px 6px;border-radius:4px}dialog label{display:block;margin:12px 0;font-weight:600}dialog input,dialog select,dialog textarea{display:block;width:100%;padding:8px;margin-top:4px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:5px}.t3-close{float:right}.t3-session{padding:10px;border-top:1px solid var(--line)}.t3-session p{overflow-wrap:anywhere}
.lane-decide summary{color:var(--acc)}.grave{opacity:.6}.grave header a{text-decoration:line-through}
.empty{color:var(--mut);font-size:13px;margin:4px}.err{margin:16px;color:var(--acc)}
@media (max-width:700px){main{flex-direction:column}.lane{flex:auto;width:100%}}
</style></head><body><h1>Repo Board<a href="/?refresh">refresh</a></h1>${panel}<main>${inner}</main>
<script>document.addEventListener("click",e=>{const b=e.target.closest("button[data-p]");if(!b)return;
navigator.clipboard.writeText(b.dataset.p).then(()=>{b.textContent="Copied";setTimeout(()=>b.textContent=b.dataset.l,1500)})})</script>
</body></html>`;
}
import { handleT3Request, parseRepositories } from "./t3.js";
import { t3Panel, t3ClientConfig } from "./t3-ui.js";
