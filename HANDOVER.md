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
- Version 2 (Decide lane, Retire, Graveyard) passes all tests and builds with `wrangler deploy --dry-run`, but is **not deployed yet**.

## Next steps
1. `npm test`, then `npx wrangler deploy`, then check the live board: Decide lane, PR ages, archived repos in Graveyard.
2. Confirm the board is behind Cloudflare Access (own email only). It shows private repo names and notes.
3. Star Rewards: add the session bookmark rule to its CLAUDE.md (it only has AGENTS.md so far).
4. Idea parked: a "Bookmark this" button so an agent drafts NOW.md for repos in "No bookmark yet".

## Ground rules
- Keep it simple: one Worker, no database unless a feature truly needs one.
- No "should work": run `npm test` and check the live page before calling anything done.
- Update NOW.md at the end of every session.

## 2026-11-03 — optional T3 mock slice

Feature branch `feat/t3-integration` adds `src/t3.js` (mock API/storage adapter),
`src/t3-ui.js` (card-opened dialog), GitHub database IDs for identity, and API/client
tests. Existing board, prompts and Nexus contract remain intact. See README for
bindings, authentication and the investigation evidence. This supersedes no
previous deployment record: **this feature has not been deployed**.

T3 is version 0.1.6. Native MCP supports persistent projects and threads, activity
reads, send/interrupt and pending questions (not approval handling). Public `/mcp` rejects an unauthenticated
initialize with 401 `invalid_mcp_credential`. Public root 200 is not proof of
Cloudflare Access protection. No authenticated Worker→T3 request or live pilot
was performed. The preferred live architecture reuses native project/thread
persistence, with explicitly verified GitHub-ID→project/workspace mapping.

No glb-viewer project appeared in the actual project list; no matching checkout
was found under /home/t3code within four levels. Do not guess its directory. Next:
identify/prepare and verify the pilot checkout/project, verify Access JWT policy
for board APIs, obtain a scoped server-side MCP client credential using the secure
secret flow, implement/test authenticated transport, then perform the user's
read-only pilot. Do not reuse the separate mock HTTP Basic password as T3 auth.

Mock limitations: no real agents/status/approvals/PR links/streaming; stopped mock
sessions cannot resume; sequential retry idempotency only; KV read-modify-write
can lose concurrent updates and is unsuitable for live execution associations.
Messages are stored only for the simulated demo. Mobile CSS and native dialog
are present; real mobile layout/keyboard acceptance remains unverified.
