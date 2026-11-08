// Where each repo is deployed on Cloudflare. Read-only.
// Needs the secret CF_API_TOKEN (read-only: Pages Read, Workers Scripts Read, Workers CI Read)
// and the plain variable CF_ACCOUNT_ID (wrangler.toml). Without them the board simply shows no badges.

const API = "https://api.cloudflare.com/client/v4";
const GRACE = 10 * 60 * 1000; // a deploy within 10 minutes after a push counts as "up to date"
const SUFFIX = /-(api|worker|staging)$/;

// One row per Pages project and per Worker:
// { kind, project, repo, git, lastDeploy, trigger }
//   git: true = a Git build is connected, false = deployed by hand, null = could not be checked
//   trigger (Pages only): "push" or "hand"
export async function loadDeploys(env, doFetch = fetch) {
  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  if (!token || !account) return null;

  const get = async (path) => {
    const r = await doFetch(`${API}/accounts/${account}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!r.ok || j.success === false) throw new Error(j.errors?.[0]?.message || `HTTP ${r.status}`);
    return j;
  };

  const out = [];

  // Pages. No per_page here: the Pages API rejects it.
  for (let page = 1, pages = 1; page <= pages && page <= 5; page++) {
    const j = await get(`/pages/projects?page=${page}`);
    pages = j.result_info?.total_pages || 1;
    for (const p of j.result || []) {
      const dep = p.latest_deployment;
      const repo = p.source?.config?.repo_name || "";
      out.push({
        kind: "Pages", project: p.name, repo, git: !!repo,
        lastDeploy: dep?.created_on || null,
        trigger: dep ? (dep.deployment_trigger?.type === "github:push" ? "push" : "hand") : null,
      });
    }
  }

  // Workers: Git-connected when Workers Builds has a trigger for the script.
  const scripts = (await get("/workers/scripts")).result || [];
  const workers = await Promise.all(scripts.slice(0, 40).map(async (s) => {
    let git = null, repo = "";
    try {
      const t = (await get(`/builds/workers/${s.tag}/triggers`)).result || [];
      git = t.length > 0;
      repo = t[0]?.repo_connection?.repo_name || "";
    } catch { /* leave it unknown rather than guess */ }
    return { kind: "Worker", project: s.id, repo, git, lastDeploy: s.modified_on || null, trigger: null };
  }));

  return out.concat(workers);
}

// The deploys that belong to one repo: a real Git connection, or a hand-deployed
// project whose name matches the repo (case-insensitive, minus -api/-worker/-staging).
export function deploysFor(name, list, pushedAt) {
  if (!Array.isArray(list)) return [];
  const n = name.toLowerCase();
  const out = [];
  for (const p of list) {
    let link = null;
    if (p.git === true && p.repo.toLowerCase() === n) link = "git";
    else if (p.git === false) {
      const pn = p.project.toLowerCase();
      if (pn === n || pn.replace(SUFFIX, "") === n) link = "name";
    }
    if (!link) continue;
    const repoNewer = !!p.lastDeploy && Date.parse(pushedAt) - Date.parse(p.lastDeploy) > GRACE;
    out.push({
      kind: p.kind, project: p.project, git: link === "git", link,
      lastDeploy: p.lastDeploy, trigger: p.trigger, repoNewer,
    });
  }
  return out;
}
