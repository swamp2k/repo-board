// Repo Board — one card per GitHub repo, sorted into lanes from NOW.md + open PRs.
// One GitHub GraphQL call per page load (cached 60 s). Read-only.
import { handleT3Request, verifyAccess, enforceRateLimit } from "./t3.js";
import { createT3Client } from "./t3-client.js";
import { handleT3AuthRequest, liveRead, liveSend } from "./t3-live.js";

const OWNER = "swamp2k";
const DAY = 86400000;

const QUERY = `query($login:String!){
  user(login:$login){
    repositories(first:100, ownerAffiliations:OWNER, orderBy:{field:PUSHED_AT,direction:DESC}){
      nodes{
        id name url pushedAt isPrivate isArchived owner{login}
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
    if (url.pathname.startsWith("/api/t3")) {
      const authResponse = await handleT3AuthRequest(request, env, {
        authenticate: verifyAccess,
        rateLimit: (identity) => enforceRateLimit(identity, env),
      });
      if (authResponse) return authResponse;
      return handleT3Request(request, env, {
        findRepo: async (id) => (await loadRepos(env.GITHUB_TOKEN)).find((r) => r.id === id) || null,
        liveRead: (req, liveEnv, identity, repo) => liveRead(req, liveEnv, identity, repo),
        liveSend: (req, liveEnv, identity, repo) => liveSend(req, liveEnv, identity, repo),
      });
    }
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });

    const cache = caches.default;
    const mode = env.T3_MODE === "mock" || env.T3_MODE === "live" ? env.T3_MODE : "disabled";
    const key = new Request(url.origin + "/__board?mode=" + mode, request);
    if (!url.searchParams.has("refresh")) {
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

    const res = new Response(page(renderBoard(repos, Date.now(), mode), mode), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, max-age=60" },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },
};

export async function loadRepos(token) {
  if (!token) throw new Error("GITHUB_TOKEN secret is not set");
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "user-agent": "repo-board", "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { login: OWNER } }),
    signal: AbortSignal.timeout(5_000),
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

function card(r, now, t3Enabled = false) {
  const t3Mode = t3Enabled === "live" ? "live" : (t3Enabled === "mock" || t3Enabled === true ? "mock" : "disabled");
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
    <span class="btns">${t3Mode !== "disabled" && r.id && (t3Mode !== "live" || (r.owner?.login === "swamp2k" && r.name === "glb-viewer")) ? `<button class="ghost" data-t3-repo="${esc(r.id)}" data-t3-name="${esc(r.owner?.login || "")}/${esc(r.name)}" data-t3-url="${esc(r.url)}" data-t3-prompt="${esc(t3InspectionPrompt(r))}" data-t3-now="${esc([n?.doing, n?.state, n?.["next step"]].filter(Boolean).join(" · ") || "No NOW.md status available")}" data-t3-has-now="${r.now ? "yes" : "no"}">${t3Mode === "live" ? "T3 conversations" : "Run in T3"}</button>` : ""}<button class="ghost" data-p="${esc(retire)}" data-l="Retire">Retire</button>
    <button data-p="${esc(prompt)}" data-l="Copy prompt">Copy prompt</button></span></footer>
  </article>`;
}

export function promptsFor(r) {
  const n = parseNow(r.now?.text);
  const prompt = `Open ${repoSubject(r, OWNER)}. ${inspectionEssentials()} First check the repository root for AGENTS.md and CLAUDE.md (exact uppercase filenames). If neither exists, create both with identical contents. If only one exists, copy its full contents to the other filename. If both exist and differ, explain the differences and propose a merged version preserving useful instructions; wait for my choice before changing either file or continuing implementation. If they are identical, keep them aligned. Preserve existing instructions and include these rules identically in both: read NOW.md at session start, update it before ending every session, and whenever either root instruction file changes, update both identically. Leave nested instruction files unchanged. ` + (r.now
    ? 'Read NOW.md and continue from "Next step". Update NOW.md before ending the session.'
    : 'Inspect the README, code, recent commits and open pull requests. Summarise the current state and suggest the next concrete action. Check whether NOW.md already exists in the repository root; read and update it if present, preserving relevant content, and create it only if missing. Use these fields: Doing, State, Next step, Blocked by, Updated (YYYY-MM-DD). Base it on verified findings; mark anything uncertain. Keep NOW.md current as work progresses. Commit and push the bookmark and instruction changes following the repository workflow (use a branch and PR if required), so they are available on GitHub. Present your findings and proposed next action, then wait for my direction before implementing further changes.');
  const retire = `Retire the repo ${OWNER}/${r.name}. First list its open pull requests and ask me what to do with each (merge, close, or leave) before doing anything. Then ask me for a one-line epitaph, write it to NOW.md as "Epitaph: <text>", commit, and archive the repo on GitHub.`;
  return { prompt, retire, inspectionPrompt: inspectionPrompt(r) };
}

function inspectionPrompt(r) {
  return `Inspect the verified workspace for ${repoSubject(r)}. ${inspectionEssentials()} Also read root NOW.md when present, then inspect recent code and repository state. Report the current state, uncertainty, and one safe next action. Ask for direction after reporting.`;
}

export function t3InspectionPrompt(r) {
  return `${inspectionPrompt(r)} This is a read-only pilot: do not modify files, create files, run formatters that write, commit, push, merge, release, deploy, or launch any additional agent.`;
}

function repoSubject(r, owner = r.owner?.login || OWNER) { return `${owner}/${r.name} (${r.url})`; }
function inspectionEssentials() { return "Read AGENTS.md, CLAUDE.md and HANDOVER.md where present."; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function page(inner, t3Enabled = false) {
  const t3Live = t3Enabled === "live";
  const t3Mock = t3Enabled === true || t3Enabled === "mock";
  const t3Active = t3Live || t3Mock;
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
.btns{display:flex;flex-wrap:wrap;gap:6px}.card footer{flex-wrap:wrap;gap:6px}.ghost{background:transparent;color:var(--mut);border:1px solid var(--line)}
.warn{font-size:12px;color:var(--acc);margin-top:6px}
.lane-decide summary{color:var(--acc)}.grave{opacity:.6}.grave header a{text-decoration:line-through}
.empty{color:var(--mut);font-size:13px;margin:4px}.err{margin:16px;color:var(--acc)}
.t3-backdrop{position:fixed;inset:0;background:#0008;z-index:10}.t3-panel{position:fixed;z-index:11;inset:0 0 0 auto;width:min(520px,100vw);height:100dvh;max-width:100vw;max-height:100dvh;margin:0;overflow:auto;background:var(--bg);color:var(--ink);border:0;border-left:1px solid var(--line);padding:18px;box-shadow:-8px 0 30px #0003}
.t3-panel h2{font-size:19px;margin:0}.t3-top{display:flex;justify-content:space-between;gap:12px;align-items:start}.t3-muted{color:var(--mut);font-size:13px}.t3-warning{margin:12px 0;padding:8px;border:1px solid var(--acc);border-radius:6px;color:var(--acc)}
.t3-list{display:grid;gap:8px;margin:14px 0}.t3-item{border:1px solid var(--line);background:var(--card);padding:10px;border-radius:8px}.t3-item button{margin:4px 4px 0 0}.t3-item p{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}.t3-msg{border-left:2px solid var(--line);padding-left:8px}.t3-badge{display:inline-block;margin:10px 0;padding:2px 8px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:var(--ink)}.t3-bubble{margin:8px 0;padding:8px 10px;border-radius:10px;line-height:1.45;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}.t3-bubble.you{background:var(--bg);border:1px solid var(--line);margin-left:24px}.t3-bubble.assistant{background:var(--card);border:1px solid var(--line);margin-right:24px}.t3-who{display:block;font-size:12px;font-weight:600;margin-bottom:2px}.t3-time{font-size:11px;color:var(--mut);float:right;font-weight:400}.t3-bubble code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;padding:0 3px;border-radius:4px;background:var(--line)}.t3-send{display:grid;gap:6px;margin-top:10px}.t3-send textarea{width:100%;min-height:70px;padding:8px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:6px;font:inherit}.t3-panel details summary{cursor:pointer;color:var(--mut);font-size:13px;margin:8px 0}.t3-status{text-transform:capitalize;color:var(--mut)}
.t3-form[hidden]{display:none}#t3-activity{white-space:pre-line}.t3-form{display:grid;gap:8px;margin-top:14px}.t3-form textarea{width:100%;min-height:90px;padding:8px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:6px;font:inherit}.t3-top{flex-wrap:wrap}.t3-panel button{max-width:100%;white-space:normal}@media(max-width:360px){.t3-panel{padding:12px}.t3-item{padding:8px}}
@media (max-width:700px){main{flex-direction:column}.lane{flex:auto;width:100%}}
</style></head><body><h1>Repo Board<a href="/?refresh">refresh</a></h1><main>${inner}</main>
${t3Active ? `<dialog class="t3-panel" id="t3-panel" aria-labelledby="t3-title"><div class="t3-top"><div><h2 id="t3-title">${t3Live ? "T3 conversations" : "Run in T3"}</h2><a id="t3-repo" class="t3-muted" target="_blank" rel="noopener"></a></div><button id="t3-close" class="ghost" type="button">Close</button></div><a id="t3-now-link" class="t3-muted" target="_blank" rel="noopener">NOW.md</a><p id="t3-now" class="t3-muted"></p><p id="t3-scope" class="t3-muted"></p>${t3Live ? `<span class="t3-badge" id="t3-badge" title="Reading always works. Sending needs T3 permission beyond read only.">glb-viewer pilot</span> <button id="t3-connect" type="button">Connect to T3</button><button id="t3-disconnect" class="ghost" type="button" hidden>Disconnect</button>` : `<div class="t3-warning">Mock mode: conversations, statuses, and activity are simulated. No T3 agent is contacted.</div>`}<p id="t3-status" class="t3-status">Connection: disconnected</p><p id="t3-error" role="alert" class="err" hidden></p><button id="t3-retry" class="ghost" type="button" hidden>${t3Live ? "Retry read" : "Retry connection"}</button><div id="t3-list" class="t3-list" aria-live="polite"></div>${t3Live ? "" : `<button id="t3-new" type="button">New mock conversation</button><form id="t3-form" class="t3-form"><label for="t3-message">Follow-up</label><textarea id="t3-message" maxlength="4000" required></textarea><button type="submit">Send mock follow-up</button></form><h3>Activity</h3><div id="t3-activity" class="t3-muted">No activity loaded.</div>`}</dialog>` : ""}
<script>
document.addEventListener("click",e=>{const b=e.target.closest("button[data-p]");if(b){navigator.clipboard.writeText(b.dataset.p).then(()=>{b.textContent="Copied";setTimeout(()=>b.textContent=b.dataset.l,1500)});return;}});
${t3Mock ? `(()=>{
const ClientFactory=(${createT3Client.toString()})();
const client=new ClientFactory({storage:localStorage,transport:async(repoId,body)=>{const r=await fetch("/api/t3?repoId="+encodeURIComponent(repoId),{method:"POST",headers:{"content-type":"application/json","x-repo-board-request":"1"},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error?.message||"Mock service unavailable");return j;}});
const panel=document.getElementById("t3-panel"),list=document.getElementById("t3-list"),error=document.getElementById("t3-error"),retry=document.getElementById("t3-retry"),activity=document.getElementById("t3-activity");let poll;
function render(){const saved=client.read();list.replaceChildren();for(const t of saved.conversations){const box=document.createElement("section");box.className="t3-item";const title=document.createElement("button");title.className="ghost";title.textContent=(t.title||"Conversation")+" · "+new Date(t.createdAt).toLocaleString();title.setAttribute("aria-pressed",String(saved.selectedId===t.id));title.onclick=()=>{saved.selectedId=t.id;client.write(client.repoId,saved);render()};box.append(title);const status=document.createElement("span");status.className="t3-status";status.textContent=" · Mock "+t.status+(t.updatedAt?" · updated "+new Date(t.updatedAt).toLocaleString():"");box.append(status);for(const m of t.messages||[]){const p=document.createElement("p");p.className="t3-msg";p.textContent="Mock "+(m.role||"assistant")+": "+m.text;box.append(p)}if(saved.selectedId===t.id){for(const action of ["resume","cancel"]){const btn=document.createElement("button");btn.className="ghost";btn.textContent="Mock "+action;btn.onclick=()=>operate(action);box.append(btn)}if(["waiting","running"].includes(t.status)){const advance=document.createElement("button");advance.className="ghost";advance.textContent="Mock advance";advance.onclick=()=>{client.advance();render()};box.append(advance)}}list.append(box)}activity.textContent=saved.activity.slice(0,10).map(x=>new Date(x.at).toLocaleTimeString()+" · "+x.text).join(String.fromCharCode(10))||"No activity yet.";document.getElementById("t3-status").textContent="Connection: "+client.connection;document.getElementById("t3-form").hidden=!saved.selectedId}
function showError(e){if(e.stale)return;error.hidden=false;error.textContent=e.message;retry.hidden=false;render()}
async function load(){error.hidden=true;retry.hidden=true;try{const result=await client.list();if(result.stale)return;const d=result.result;document.getElementById("t3-scope").textContent=d.project.workspaceRoot+" · synthetic workspace";render()}catch(e){showError(e)}}
async function operate(action){try{const result=await client.operation(action);if(!result.stale)render()}catch(e){showError(e)}}
document.addEventListener("click",e=>{const b=e.target.closest("[data-t3-repo]");if(!b)return;client.select(b.dataset.t3Repo);const ctx={repoId:b.dataset.t3Repo,prompt:b.dataset.t3Prompt};document.getElementById("t3-title").textContent="Run in T3 · "+b.dataset.t3Name;const link=document.getElementById("t3-repo");link.textContent=b.dataset.t3Name;link.href=b.dataset.t3Url;document.getElementById("t3-now").textContent="NOW.md · "+b.dataset.t3Now;const nowLink=document.getElementById("t3-now-link");const repoUrl=b.dataset.t3Url.endsWith("/")?b.dataset.t3Url.slice(0,-1):b.dataset.t3Url;nowLink.href=repoUrl+"/blob/HEAD/NOW.md";nowLink.hidden=b.dataset.t3HasNow!=="yes";render();panel.showModal();load();clearInterval(poll);poll=setInterval(()=>{if(panel.open&&client.repoId===ctx.repoId)load();else clearInterval(poll)},8000)});
document.getElementById("t3-close").onclick=()=>panel.close();panel.addEventListener("close",()=>clearInterval(poll));retry.onclick=load;
document.getElementById("t3-new").onclick=async()=>{const repoId=client.repoId;const prompt=document.querySelector('[data-t3-repo="'+CSS.escape(repoId)+'"]')?.dataset.t3Prompt;if(!prompt){showError(new Error("Inspection prompt is unavailable"));return}const pendingKey="repo-board-t3-mock:"+repoId+":pending";let requestId=localStorage.getItem(pendingKey);if(!requestId){requestId=crypto.randomUUID();localStorage.setItem(pendingKey,requestId)}try{const result=await client.create(prompt,requestId);localStorage.removeItem(pendingKey);if(!result.stale)render()}catch(e){showError(e)}};
document.getElementById("t3-form").onsubmit=async e=>{e.preventDefault();const text=document.getElementById("t3-message").value.trim();if(!text)return;try{const result=await client.followup(text);if(!result.stale){e.target.reset();render()}}catch(err){showError(err)}};
})();` : ""}
${t3Live ? `(()=>{
const panel=document.getElementById("t3-panel"),list=document.getElementById("t3-list"),error=document.getElementById("t3-error"),retry=document.getElementById("t3-retry"),status=document.getElementById("t3-status"),connect=document.getElementById("t3-connect"),disconnect=document.getElementById("t3-disconnect");let repoId="",poll=null,connected=false,canSend=false,draft="",launchDraft="",launchRequestId="",csrfToken="",generation=0,controller=null,listCursor="",nextCursor="",nextPosition=null;
const selectionKey="repo-board-t3-live-selection";
function selection(){try{return JSON.parse(localStorage.getItem(selectionKey)||"null")}catch{return null}}
function saveSelection(threadId,cursor=listCursor){localStorage.setItem(selectionKey,JSON.stringify({repoId,threadId,cursor}))}
function invalidate(){generation++;controller?.abort();controller=null;return generation}
function setDisconnected(){connected=false;csrfToken="";connect.hidden=false;disconnect.hidden=true;list.replaceChildren();status.textContent="Connection: disconnected"}
function inline(el,text){const bt=String.fromCharCode(96);for(const part of String(text).split(new RegExp("([*][*][^*]+[*][*]|"+bt+"[^"+bt+"]+"+bt+")"))){if(!part)continue;if(part.startsWith("**")&&part.endsWith("**")&&part.length>4){const b=document.createElement("strong");b.textContent=part.slice(2,-2);el.append(b)}else if(part.startsWith(bt)&&part.endsWith(bt)&&part.length>2){const c=document.createElement("code");c.textContent=part.slice(1,-1);el.append(c)}else el.append(document.createTextNode(part))}}
function bubble(item){const you=item.type==="user_message",div=document.createElement("div");div.className="t3-bubble "+(you?"you":"assistant");const who=document.createElement("span");who.className="t3-who";who.textContent=you?"You":item.type==="assistant_message"?"T3":"Activity";if(item.at){const t=document.createElement("span");t.className="t3-time";t.textContent=new Date(item.at).toLocaleString([], {dateStyle:"short",timeStyle:"short"});who.append(t)}div.append(who);inline(div,item.text+(item.textTruncated?" …":""));return div}
function launchForm(cursor){const det=document.createElement("details");det.className="t3-item";const sum=document.createElement("summary");sum.textContent="Start new conversation";det.append(sum);if(launchDraft)det.open=true;const wrap=document.createElement("div");wrap.className="t3-send";const box=document.createElement("textarea");box.maxLength=4000;box.placeholder="What should T3 do in this repository?";box.value=launchDraft;box.oninput=()=>{launchDraft=box.value;go.textContent="Start in T3"};const go=document.createElement("button");go.type="button";go.textContent="Start in T3";const note=document.createElement("span");note.className="t3-muted";go.onclick=async()=>{const message=box.value.trim();if(!message)return;if(go.textContent!=="Click again to start"){go.textContent="Click again to start";return}go.disabled=true;note.textContent=" Starting…";if(!launchRequestId)launchRequestId=crypto.randomUUID();try{const r=await request("/api/t3?repoId="+encodeURIComponent(repoId),{method:"POST",headers:{"content-type":"application/json","x-repo-board-request":"1","x-repo-board-csrf":csrfToken},body:JSON.stringify({csrf:csrfToken,action:"launch",message,clientRequestId:launchRequestId})});launchDraft="";launchRequestId="";if(r.threadId)saveSelection(r.threadId,"");setTimeout(()=>load(r.threadId||"",""),3000);note.textContent=" Started."}catch(e){go.disabled=false;go.textContent="Start in T3";note.textContent="";showError(e.message)}};wrap.append(box,go,note);det.append(wrap);return det}
function sendForm(threadId,cursor){const wrap=document.createElement("div");wrap.className="t3-send";const box=document.createElement("textarea");box.maxLength=4000;box.placeholder="Message to T3 (it will be queued if T3 is busy)";box.value=draft;box.oninput=()=>{draft=box.value;send.textContent="Send to T3"};const quick=document.createElement("button");quick.className="ghost";quick.type="button";quick.textContent="Take the next step";quick.onclick=()=>{box.value=draft="Please go ahead with the next step you described.";send.textContent="Send to T3"};const send=document.createElement("button");send.type="button";send.textContent="Send to T3";const note=document.createElement("span");note.className="t3-muted";send.onclick=async()=>{const message=box.value.trim();if(!message)return;if(send.textContent!=="Click again to send"){send.textContent="Click again to send";return}send.disabled=true;note.textContent=" Sending…";try{await request("/api/t3?repoId="+encodeURIComponent(repoId),{method:"POST",headers:{"content-type":"application/json","x-repo-board-request":"1","x-repo-board-csrf":csrfToken},body:JSON.stringify({csrf:csrfToken,threadId,message})});draft="";box.value="";send.disabled=false;send.textContent="Send to T3";note.textContent=" Sent. T3 will pick it up.";setTimeout(()=>load(threadId,cursor),3000)}catch(e){send.disabled=false;send.textContent="Send to T3";note.textContent="";showError(e.message)}};wrap.append(box,quick,send,note);return wrap}
function showError(message){error.hidden=false;error.textContent=message;retry.hidden=false}
async function request(url,init={},signal){const r=await fetch(url,{...init,signal});const j=await r.json().catch(()=>{throw Error("Refresh Repo Board and sign in again; the connection response was invalid.")});if(!r.ok){const e=Error(j.error?.message||"T3 service is temporarily unavailable");e.code=j.error?.code;throw e}return j}
async function checkSession(gen,signal){try{const s=await request("/api/t3/auth/session",{headers:{"x-repo-board-request":"1"}},signal);if(gen!==generation)return false;connected=s.connected;canSend=s.canSend===true;csrfToken=s.csrf||"";connect.hidden=connected;disconnect.hidden=!connected;status.textContent="Connection: "+(connected?"connected · "+(canSend?"can send":"read only"):"disconnected");if(!connected)list.replaceChildren();return connected}catch(e){if(gen!==generation)return false;if(e.name!=="AbortError")showError(e.message);return false}}
async function load(threadId="",cursor=listCursor,position=null){const gen=invalidate();controller=new AbortController();const signal=controller.signal;error.hidden=true;retry.hidden=true;try{if(!await checkSession(gen,signal)||gen!==generation)return;const q="/api/t3?repoId="+encodeURIComponent(repoId)+(threadId?"&threadId="+encodeURIComponent(threadId):"")+(cursor?"&cursor="+encodeURIComponent(cursor):"")+(position!==null?"&position="+encodeURIComponent(position):"");const d=await request(q,{},signal);if(gen!==generation||!panel.open)return;listCursor=cursor;nextCursor=d.nextCursor||"";nextPosition=d.selected?.hasMore?d.selected.nextPosition:null;document.getElementById("t3-scope").textContent=d.project.workspaceRoot+(Number.isSafeInteger(d.total)&&d.total>d.conversations.length?" · showing "+d.conversations.length+" of "+d.total:"");list.replaceChildren();if(canSend)list.append(launchForm(cursor));if(!d.conversations.length){const p=document.createElement("p");p.className="t3-muted";p.textContent="No conversations in this T3 project yet. Start one in T3; it will show up here.";list.append(p)}for(const t of d.conversations){const box=document.createElement("section");box.className="t3-item";const button=document.createElement("button");button.className="ghost";button.textContent=(t.title||"Conversation")+(t.createdAt?" · "+new Date(t.createdAt).toLocaleString():"");button.setAttribute("aria-pressed",String(selection()?.threadId===t.id));button.onclick=()=>{saveSelection(t.id,cursor);load(t.id,cursor)};box.append(button);const meta=document.createElement("span");meta.className="t3-status";meta.textContent=" · "+(t.status||"status unavailable")+(t.updatedAt?" · updated "+new Date(t.updatedAt).toLocaleString():"");box.append(meta);if(d.selected?.id===t.id){const items=d.selected.items,lastIdx=items.map(x=>x.type).lastIndexOf("assistant_message"),answer=lastIdx>=0?items[lastIdx]:null;if(answer)box.append(bubble(answer));else{const p=document.createElement("p");p.className="t3-muted";p.textContent="No answer yet.";box.append(p)}const rest=items.filter((_,k)=>k!==lastIdx);if(rest.length){const det=document.createElement("details"),sum=document.createElement("summary");sum.textContent="Show full conversation ("+items.length+" messages)";det.append(sum);for(const item of items)det.append(bubble(item));box.append(det)}if(canSend)box.append(sendForm(t.id,cursor));if(d.selected.hasMore&&d.selected.nextPosition!==null){const more=document.createElement("button");more.className="ghost";more.textContent="Load more messages";more.onclick=()=>load(t.id,cursor,d.selected.nextPosition);box.append(more)}}list.append(box)}if(d.hasMore&&nextCursor){const more=document.createElement("button");more.className="ghost";more.textContent="Load more conversations";more.onclick=()=>load("",nextCursor);list.append(more)}if(d.selected)saveSelection(d.selected.id,cursor);status.textContent="Connection: connected · "+(canSend?"can send":"read only")}catch(e){if(gen!==generation||e.name==="AbortError")return;if(e.code==="conversation_not_found"&&threadId){try{localStorage.removeItem(selectionKey)}catch{}load("","");return}if(e.code==="t3_session_expired"||e.code==="t3_not_connected"){setDisconnected();showError("T3 sign-in expired. Connect to T3 again to continue.");return}showError(e.message)}}
function openCard(b){repoId=b.dataset.t3Repo;document.getElementById("t3-title").textContent="T3 conversations · "+b.dataset.t3Name;const link=document.getElementById("t3-repo");link.textContent=b.dataset.t3Name;link.href=b.dataset.t3Url;document.getElementById("t3-now").textContent="NOW.md · "+b.dataset.t3Now;const nowLink=document.getElementById("t3-now-link"),repoUrl=b.dataset.t3Url.endsWith("/")?b.dataset.t3Url.slice(0,-1):b.dataset.t3Url;nowLink.href=repoUrl+"/blob/HEAD/NOW.md";nowLink.hidden=b.dataset.t3HasNow!=="yes";panel.showModal();const saved=selection();listCursor=saved?.repoId===repoId?saved.cursor||"":"";load(saved?.repoId===repoId?saved.threadId||"":"",listCursor);clearInterval(poll);poll=setInterval(()=>{if(panel.open&&(draft||launchDraft))return;if(panel.open){const selected=selection();const selectedId=selected?.repoId===repoId&&selected.cursor===listCursor?selected.threadId||"":"";load(selectedId,listCursor)}else clearInterval(poll)},15000)}
document.addEventListener("click",e=>{const b=e.target.closest("[data-t3-repo]");if(b)openCard(b)});
document.getElementById("t3-close").onclick=()=>panel.close();panel.addEventListener("close",()=>{clearInterval(poll);invalidate();list.replaceChildren()});retry.onclick=()=>{const saved=selection();load(saved?.repoId===repoId?saved.threadId||"":"",listCursor)};
connect.onclick=async()=>{error.hidden=true;try{if(!csrfToken){const gen=invalidate();controller=new AbortController();await checkSession(gen,controller.signal)}const result=await request("/api/t3/auth/start",{method:"POST",headers:{"content-type":"application/json","x-repo-board-request":"1","x-repo-board-csrf":csrfToken},body:JSON.stringify({csrf:csrfToken})});location.assign(result.authorizationUrl)}catch(e){showError(e.message)}};
disconnect.onclick=async()=>{invalidate();try{await request("/api/t3/auth/disconnect",{method:"POST",headers:{"content-type":"application/json","x-repo-board-request":"1","x-repo-board-csrf":csrfToken},body:JSON.stringify({csrf:csrfToken})});setDisconnected();error.hidden=true}catch(e){showError(e.message)}};
const query=new URLSearchParams(location.search);if(query.get("t3")){history.replaceState(null,"",location.pathname+location.hash);if(query.get("t3")==="error"){panel.showModal();showError("T3 sign-in was not completed ("+(query.get("reason")||"unknown")+"). Check T3 permissions and try again.");}else if(query.get("t3")==="connected"){const button=document.querySelector('[data-t3-repo="'+CSS.escape(query.get("repoId")||"")+'"]');if(button)openCard(button);else showError("T3 connected. Open the glb-viewer card to view conversations.")}}
})();` : ""}
</script>
</body></html>`;
}
