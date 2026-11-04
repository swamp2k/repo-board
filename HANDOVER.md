# Repo Board — handover

## What it is
A kanban-style board over all of swamp2k's GitHub repos. One card per repo. One Cloudflare Worker, read-only against GitHub (one GraphQL call per page load, cached 60 s). Optional live T3 OAuth credentials and PKCE state use a Durable Object scoped by verified Access subject plus browser-cookie hash; T3 continues to own conversations.

Purpose: Martin keeps losing track of what he was doing inside each project. Each repo carries a `NOW.md` "where I left off" bookmark; the board shows those bookmarks and sorts repos into lanes.

## Files
- `src/worker.js` — board Worker (data fetch, lane rules, HTML, API routing)
- `src/t3-live.js` — native T3 OAuth, browser-session-scoped Durable Object storage handler, and allowlisted read-only MCP client
- `src/entry.js` — Nexus entrypoint and exported `T3AuthStore` Durable Object class
- `test/board.test.mjs` — lane and rendering tests, run with `npm test`
- `wrangler.toml` — disabled-by-default Worker config. Secret `GITHUB_TOKEN` is set with `wrangler secret put`, never committed.
- `wrangler.live.example.toml` — live-only variables and rate-limit binding example; it has placeholders and is not deploy-ready.
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
- The mock adapter does not call T3. Mock threads/activity persist only in this browser's `localStorage`. Live mode implements public-client OAuth with S256 PKCE, exact read-only scope and callback-issuer checks, and browser-specific opaque sessions isolated by the Access subject and cookie hash. MCP reads are fixed to `swamp2k/glb-viewer` and use the native T3 `threadId`/`items` contract with bounded pagination. Live UI has no write, launch, resume, or cancel controls. `npm test` covers Worker rendering/cache mode, callback issuer/state handling, two-browser isolation, JSON and multiline SSE correlation, upstream failures/size cancellation, native envelope normalization, UI response races, rate limiting, prior mock behavior, JWT verification, and Nexus v1 compatibility.
- The reviewed pilot config is `wrangler.pilot.toml`; rollback config `wrangler.pilot.rollback.toml` keeps the same DO migration and rate binding but sets `T3_MODE = "disabled"`. The main disabled config remains unchanged. The pilot uses verified Access values and its actual three-email allow policy, board origin, one glb-viewer mapping, DO migration, and unused account rate namespace ID `1001`. It also sets `observability.redact_query_string = true` and disables invocation logs. The current Access app covers the board workers.dev hostname and is configured with no bypass decision; its team and audience match the pilot config. Previously exposed version URLs are disabled in both pilot configs via `preview_urls = false`. The user-approved pilot is deployed, and post-deployment metadata confirms preview URLs disabled while the normal hostname remains enabled. Existing Access policies are unchanged.
- Baseline inspection: account `98b26d7882ddf77fcd45529f35b11202`; app `8ec99f09-ead8-4986-9325-dd461db16a1c`; active deployment `55d0669b-337f-4a9d-afdd-a85051a1665b`; active version `aff4efbd-e955-4acb-a4c9-df119d8cab9d`; current code entrypoint `NexusIntegration.getBoard`; only existing binding is secret `GITHUB_TOKEN`. Code bundle and metadata backup are outside the repo at `/home/t3code/.local/state/repo-board/pilot-baseline` with mode `0600`; secret value was not read or included. That snapshot preceded the pilot. The approved deployment subsequently created the private auth-store and rate-limit bindings; no merge, T3 security change, or glb-viewer modification occurred.
- Native project map: `repo-board` remains at `/home/t3code/repo-board` with canonical GitHub remote `github.com/swamp2k/repo-board`. The glb-viewer project ID `mcp:6ccdf28e-d941-4b71-a636-a344020b5643` remains at `/projects/glb-viewer`; project list reported canonical GitHub identity `github.com/swamp2k/glb-viewer`, while direct project read omitted `repositoryIdentity`. The verified mapping used by config pins its known GitHub node ID `R_kgDOUSfguQ` and exact T3 project ID/root.
- Historical 2026-11-03 Access setup attempt: Cloudflare rejected a service-token creation request with HTTP 403/code 1010. No Access app/policy or T3 credential was created and no configuration changed. This does not block the native T3 OAuth implementation; keep the board's existing Access protection and allowlist as a prerequisite.

Supervisor verification: `npm test`, `git diff --check`, and Wrangler 4.157.0 dry-run builds of default and live-example configurations passed. This pilot-preparation pass also passed `npm test`, `git diff --check`, and Wrangler 4.157.0 dry-runs for both pilot and disabled rollback configs. Browser UI fixture checks passed at 320px/1280px for layout, selected messages, Escape, close/reopen restore and disconnect. Real native registration returned 201; no authenticated OAuth approval or board-to-T3 read has completed.

## Next steps
1. Pilot deployed at version `f44bb72b-1397-4dd4-805f-577d80716ee6` using `wrangler.pilot.toml --keep-vars`. Verified live configuration, GitHub secret retention, private auth store, 60/minute limiter, and disabled version preview URLs. Anonymous API/auth/callback requests redirect to Access. Continue with user sign-in and native T3 Read only approval, then verify real list/read and rate limiting. Do not copy or rotate the existing GitHub secret.
2. Complete native T3 approval with exactly `orchestration:read`, then verify real list/read behavior, unauthorized denial, rate limiting, close/reopen, and disconnect/revoke handling. The checkout has no authenticated live acceptance yet.
3. For rollback, deploy `npx wrangler deploy --config wrangler.pilot.rollback.toml --keep-vars`; retain the DO namespace and migration.
4. Mock conversations remain browser-local. Live credentials are server side in the Durable Object; conversation data remains at T3 and is fetched on demand.
5. Star Rewards: add the session bookmark rule to its CLAUDE.md (it only has AGENTS.md so far).
6. Idea parked: a "Bookmark this" button so an agent drafts NOW.md for repos in "No bookmark yet".

## Ground rules
- Keep it simple: one Worker, no database unless a feature truly needs one.
- No "should work": run `npm test` and check the live page before calling anything done.
- Update NOW.md at the end of every session.
