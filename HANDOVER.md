# Repo Board — handover

## What it is
A kanban-style board over all of swamp2k's GitHub repos. One card per repo. One Cloudflare Worker, no database, read-only against GitHub (one GraphQL call per page load, cached 60 s). Optionally also read-only against the Cloudflare API to show where each repo is deployed (cached 10 minutes).

Purpose: Martin keeps losing track of what he was doing inside each project. Each repo carries a `NOW.md` "where I left off" bookmark; the board shows those bookmarks and sorts repos into lanes.

## Files
- `src/worker.js` — the Worker (data fetch, lane rules, HTML)
- `src/deploys.js` — optional Cloudflare lookup: Pages projects, Workers and their Git build triggers, matched to repos
- `src/entry.js` — Worker entry plus the `NexusIntegration` entrypoint
- `test/board.test.mjs`, `test/deploys.test.mjs` — lane, rendering and deploy tests, run with `npm test`
- `wrangler.toml` — Worker config. `CF_ACCOUNT_ID` is a plain variable. Secrets `GITHUB_TOKEN` and `CF_API_TOKEN` are set with `wrangler secret put`, never committed
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

## Deploy badges (optional)
Each card can show where its repo is deployed on Cloudflare, for example `Worker nexus · Git build · 7 d ago`.
- **Git build** — Pages project with a connected repo, or a Worker with a Workers Builds trigger. **by hand** — a Worker or Pages project whose name matches the repo (case-insensitive, minus `-api`, `-worker`, `-staging`) but has no Git connection. The name match is a guess, so those lines say "by hand" rather than "connected".
- **repo is newer** — the repo was pushed more than 10 minutes after the last deploy. A hint only: any branch push counts.
- Needs secret `CF_API_TOKEN`, read-only on Pages, Workers Scripts and Workers CI (Workers Builds), scoped to this one account. Without it the board looks exactly as before.
- Any Cloudflare error just hides the badges. The page never fails because of them.
- Nexus data (`buildBoard`) stays `contractVersion: 1`. It gained two additive fields: `deploysAvailable` and `deploys` on every repo.

## Buttons (copy a prompt to the clipboard; the board never writes)
- **Resume** — "Read NOW.md and continue from Next step"
- **Retire** — the agent must first list open PRs and ask Martin about each, then ask for an epitaph, write it to NOW.md, commit, archive the repo. Cards with open PRs show a warning.

## Status
- Version 1 is deployed and works against real GitHub (Martin's screenshot, 2026-10-31).
- Version 2 (Decide lane, Retire, Graveyard) passes all tests and builds with `wrangler deploy --dry-run`, but is **not deployed yet**.

- Deploy badges (2026-11-08): committed to main. `npm test` passes and `wrangler deploy --dry-run` builds. **Not deployed yet.** Badges stay hidden until `CF_API_TOKEN` is set. Not yet checked against the live Cloudflare API with a real token.
- As of 2026-11-08 this Worker has **no Git build connected** in Cloudflare, so every deploy is a manual `wrangler deploy`.

## Next steps
0. Connect this repo under Cloudflare, Workers & Pages, repo-board, Settings, Builds (set the build command to `npm test`, and consider excluding `*.md` paths so NOW.md-only commits do not redeploy). Otherwise run `npx wrangler deploy` by hand.
0. Create a read-only Cloudflare API token (Pages Read, Workers Scripts Read, Workers CI Read, this account only), run `npx wrangler secret put CF_API_TOKEN`, then check the live board for badges, including "by hand" on repo-board itself until Git is connected.
1. `npm test`, then `npx wrangler deploy`, then check the live board: Decide lane, PR ages, archived repos in Graveyard.
2. Confirm the board is behind Cloudflare Access (own email only). It shows private repo names and notes.
3. Star Rewards: add the session bookmark rule to its CLAUDE.md (it only has AGENTS.md so far).
4. Idea parked: a "Bookmark this" button so an agent drafts NOW.md for repos in "No bookmark yet".

## Ground rules
- Keep it simple: one Worker, no database unless a feature truly needs one.
- No "should work": run `npm test` and check the live page before calling anything done.
- Update NOW.md at the end of every session.
