import assert from "node:assert";
import { loadDeploys, deploysFor } from "../src/deploys.js";
import { renderBoard, buildBoard } from "../src/worker.js";

// --- loadDeploys, with a fake Cloudflare API --------------------------------
const env = { CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
const calls = [];
const ok = (result, extra = {}) => ({ ok: true, json: async () => ({ success: true, result, ...extra }) });
const fakeFetch = async (url, init) => {
  calls.push(url);
  assert.equal(init.headers.authorization, "Bearer t");
  const path = url.replace("https://api.cloudflare.com/client/v4/accounts/acct", "");
  if (path === "/pages/projects?page=1") {
    return ok([
      { name: "noteflow-v2", source: { config: { repo_name: "noteflow-v2" } }, latest_deployment: { created_on: "2026-11-04T20:51:52Z", deployment_trigger: { type: "github:push" } } },
      { name: "oddlysatisfying", source: { config: { repo_name: "oddlysatisfying" } }, latest_deployment: { created_on: "2026-07-02T17:37:24Z", deployment_trigger: { type: "ad_hoc" } } },
      { name: "startpage", latest_deployment: { created_on: "2026-07-06T14:07:09Z", deployment_trigger: { type: "ad_hoc" } } },
    ], { result_info: { total_pages: 1 } });
  }
  if (path === "/workers/scripts") {
    return ok([
      { id: "nexus", tag: "t1", modified_on: "2026-11-01T21:15:03Z" },
      { id: "repo-board", tag: "t2", modified_on: "2026-11-04T00:36:11Z" },
      { id: "star-rewards-staging", tag: "t3", modified_on: "2026-09-21T20:56:53Z" },
      { id: "broken", tag: "t4", modified_on: "2026-01-01T00:00:00Z" },
    ]);
  }
  if (path === "/builds/workers/t1/triggers") return ok([{ repo_connection: { repo_name: "nexus" } }]);
  if (path === "/builds/workers/t2/triggers" || path === "/builds/workers/t3/triggers") return ok([]);
  if (path === "/builds/workers/t4/triggers") return { ok: false, status: 500, json: async () => ({ success: false, errors: [{ message: "boom" }] }) };
  throw new Error("unexpected url " + url);
};

assert.equal(await loadDeploys({}, fakeFetch), null, "no token means no deploy data");
assert.equal(calls.length, 0);

const list = await loadDeploys(env, fakeFetch);
assert(!calls.some((u) => u.includes("per_page")), "Pages API must not get per_page");
const by = Object.fromEntries(list.map((p) => [p.project, p]));
assert.equal(by["noteflow-v2"].git, true);
assert.equal(by["noteflow-v2"].trigger, "push");
assert.equal(by["oddlysatisfying"].git, true);
assert.equal(by["oddlysatisfying"].trigger, "hand");
assert.equal(by["startpage"].git, false);
assert.equal(by["nexus"].git, true);
assert.equal(by["nexus"].repo, "nexus");
assert.equal(by["repo-board"].git, false);
assert.equal(by["broken"].git, null, "a failed check stays unknown");

// --- deploysFor -------------------------------------------------------------
const pushed = "2026-11-05T00:00:00Z";
assert.deepEqual(deploysFor("nexus", list, pushed).map((d) => [d.project, d.link]), [["nexus", "git"]]);
assert.deepEqual(deploysFor("NoteFlow-V2", list, pushed).map((d) => d.project), ["noteflow-v2"]);
assert.deepEqual(deploysFor("repo-board", list, pushed).map((d) => [d.project, d.link, d.git]), [["repo-board", "name", false]]);
assert.deepEqual(deploysFor("star-rewards", list, pushed).map((d) => [d.project, d.link]), [["star-rewards-staging", "name"]]);
assert.deepEqual(deploysFor("broken", list, pushed), [], "unknown projects are never name-matched");
assert.deepEqual(deploysFor("nothing-here", list, pushed), []);
assert.deepEqual(deploysFor("nexus", null, pushed), []);
// repoNewer: pushed more than 10 minutes after the last deploy
assert.equal(deploysFor("repo-board", list, "2026-11-04T00:40:00Z")[0].repoNewer, false); // 4 min later
assert.equal(deploysFor("repo-board", list, "2026-11-05T00:00:00Z")[0].repoNewer, true);

// --- rendering --------------------------------------------------------------
const now = Date.parse("2026-11-06T12:00:00Z");
const repo = (o) => ({ name: "r", url: "u", pushedAt: "2026-11-05T00:00:00Z", isPrivate: false, isArchived: false, now: null, pullRequests: { totalCount: 0, nodes: [] }, ...o });
const repos = [repo({ name: "nexus" }), repo({ name: "repo-board" }), repo({ name: "lonely" })];
const withDeploys = renderBoard(repos, now, list);
assert(withDeploys.includes("Worker</b> nexus · Git build"));
assert(withDeploys.includes("Worker</b> repo-board · by hand"));
assert(withDeploys.includes("repo is newer"));
assert(!withDeploys.includes("lonely ·"), "repos with no deploy get no badge");
const without = renderBoard(repos, now);
assert(!without.includes('class="dep"'), "no deploy data means no badges");
assert(without.includes("Retire"), "board still renders as before");

// --- Nexus data -------------------------------------------------------------
const board = buildBoard(repos, now, list);
assert.equal(board.contractVersion, 1);
assert.equal(board.deploysAvailable, true);
const flat = board.lanes.flatMap((l) => l.repos);
assert.equal(flat.find((r) => r.name === "nexus").deploys[0].git, true);
assert.deepEqual(flat.find((r) => r.name === "lonely").deploys, []);
assert.equal(buildBoard(repos, now).deploysAvailable, false);

console.log("deploys tests passed");
