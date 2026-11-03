# Repo Board — handover

## What it is
A kanban-style board over all of swamp2k's GitHub repos. One card per repo. One Cloudflare Worker, no database, read-only against GitHub (one GraphQL call per page load, cached 60 s).

Purpose: Martin keeps losing track of what he was doing inside each project. Each repo carries a `NOW.md` "where I left off" bookmark; the board shows those bookmarks and sorts repos into lanes.

## Files
- `src/worker.js` — the whole Worker (data fetch, lane rules, HTML)
- `test/board.test.mjs` — lane and rendering tests, run with `npm test`
- `wrangler.toml` — Worker config. Secret `GITHUB_TOKEN` is set with `wrangler secret put`, never committed
- `README.md` — deploy steps

## Lanes (rules live in `laneFor`)
1. **Decide** — open PR(s), the freshest untouched for more than 14 days
2. **Waiting for review** — open PR updated within 14 days
3. **In progress** — has NOW.md, pushed within 14 days
4. **Paused** — has NOW.md, untouched for more than 14 days
5. **No bookmark yet** — no NOW.md, pushed within 30 days
6. **Gathering dust** — no NOW.md, older (collapsed)
7. **Graveyard** — archived repos, shows `Epitaph:` from NOW.md (collapsed)

## NOW.md format
```
## Where I left off
Doing: ...
State: ...
Next step: ...
Blocked by: ...
Updated: YYYY-MM-DD
```
Retired repos add `Epitaph: <one line>`.
Repos glb-viewer, star-rewards and Ebeltoft3D already have NOW.md plus a CLAUDE.md/AGENTS.md rule to keep it updated.

## Buttons (copy a prompt to the clipboard; the board never writes)
- **Resume** — "Read NOW.md and continue from Next step"
- **Retire** — the agent must first list open PRs and ask Martin about each, then ask for an epitaph, write it to NOW.md, commit, archive the repo. Cards with open PRs show a warning.

## Status
- Version 1 is deployed and works against real GitHub (Martin's screenshot, 2026-10-31).
- Version 2 (Decide lane, Retire, Graveyard) was previously verified locally but deployment status is not confirmed here; do not deploy automatically.
- `feat/t3-workspace-integration` adds an optional mock-first T3 panel and a fail-closed API boundary. The mock adapter does not call T3. Mock threads/activity persist only in this browser's localStorage. Tests execute the injectable client and cover opaque repo IDs, stale/duplicate mappings, JWT verification, authorization/CSRF, repo isolation and async switching, idempotent mock create, reload selection, retry/failure states, exact prompt and Nexus v1 compatibility, fail-closed modes, and responsive dialog behavior.
- Cloudflare Access configuration and policy remain unverified. Live T3 endpoint/auth contract, project mapping, and durable server conversation storage remain unresolved. No live acceptance test, deployment, D1 binding, or T3 resource creation was performed. On 2026-11-03, `https://t3.jeppesen.cc/` returned HTTP 200 without redirect when probed unauthenticated; this does not establish Access protection or API authorization.

## Next steps
1. Review the `feat/t3-workspace-integration` diff and test results; do not deploy or merge automatically.
2. Before a read-only pilot, verify the existing Access application/team domain/audience/allowlist and whether the board itself is protected.
3. Verify the supported T3 remote transport and authentication, project and thread association, and polling behavior, then verify the selected workspace and mapping. No `glb-viewer` mapping was found in this environment. The user's existing authorization covers the read-only pilot after these prerequisites are verified; do not ask for additional pilot authorization. No automatic deployment is authorized.
4. Choose durable server side conversation persistence before multi-device use. Current mock conversations are browser localStorage only; no D1 binding or database ID was added.
5. Star Rewards: add the session bookmark rule to its CLAUDE.md (it only has AGENTS.md so far).
6. Idea parked: a "Bookmark this" button so an agent drafts NOW.md for repos in "No bookmark yet".

## Ground rules
- Keep it simple: one Worker, no database unless a feature truly needs one.
- No "should work": run `npm test` and check the live page before calling anything done.
- Update NOW.md at the end of every session.
