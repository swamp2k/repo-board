# Repo Board

One card per GitHub repo, sorted into lanes from each repo's `NOW.md` and open PRs.

Lanes:
- **Waiting for review** – the repo has an open PR
- **In progress** – has a NOW.md, touched within 14 days
- **Paused** – has a NOW.md, untouched for more than 14 days
- **No bookmark yet** – no NOW.md, touched within 30 days
- **Gathering dust** – no NOW.md, untouched for more than 30 days (collapsed)

Cards fade the longer they go untouched. "Resume" copies a prompt to paste into Claude Code or Codex.

It only reads from GitHub. It never writes to your repos.

## Optional T3 workspace panel (mock first)

The T3 panel is disabled unless `T3_MODE` is explicitly set. `T3_MODE=mock` enables a clearly labeled simulator; it does not contact T3. Conversations and activity are stored in browser `localStorage`, so they persist across panel close and page reload in that browser only. They are not shared across browsers and are not server durable. Mock projects and workspace names are synthetic (`mock-project-<GitHub ID>` and `/mock/<owner>/<repo>`).

The panel starts new mock conversations with a read-only inspection prompt. It asks the agent to read the root `AGENTS.md`, `CLAUDE.md`, `NOW.md`, and `HANDOVER.md` files when present, inspect recent code, report current state and uncertainty, and suggest one safe next action. It forbids file changes, commits, pushes, merges, releases, deployments, and launching another agent. The existing Copy Prompt text is unchanged.

### T3 facts and limits verified for this slice

- The installed T3 CLI/MCP version is 0.1.6. Verified MCP capabilities include project listing/reading, thread listing/reading/sending/launching/interruption, and snapshots/activity polling. No event subscription was verified. Pending questions are visible, but no verified tool answers approvals.
- The CLI advertises HTTP/WebSocket and scoped bearer sessions; the remote API and authentication contract have not been verified. The adapter therefore does not connect to a live endpoint. `T3_MODE=live` validates a configured repo/project mapping, then returns a clear `live_transport_unavailable` error.
- No registered `glb-viewer` T3 project, matching local workspace under `/home/t3code`, or linked environment was found. No pilot mapping is included.
- Existing Cloudflare Access policy is unverified. Every `/api/t3` request, including reads, requires a verified Access JWT and explicit allowed email or subject. The Worker checks issuer, audience, expiry, signature via the Access JWKS, foreign-Origin rejection on reads, and exact request origin plus a JSON custom header on writes. Missing auth config fails closed. Do not substitute an email header or add a local authentication bypass.
- On 2026-11-03 the unauthenticated HTTPS request to `https://t3.jeppesen.cc/` returned HTTP 200 without redirect. This root-page observation does not establish Access protection or API authorization.

### Mock configuration

For API-backed local panel use, add `T3_MODE=mock`, the existing read-only `GITHUB_TOKEN`, and Access values copied from a verified Cloudflare Access application to `.dev.vars` (do not commit that file):

```dotenv
T3_MODE=mock
ACCESS_TEAM_DOMAIN=https://<verified-team>.cloudflareaccess.com
ACCESS_AUD=<verified-application-audience>
ACCESS_ALLOWED_EMAILS=<approved-email>
# Or use ACCESS_ALLOWED_SUBJECTS=<approved-subject-id> instead.
```

Run `npx wrangler dev` after Wrangler is available. The local panel's API requests intentionally fail closed unless they carry a valid Access assertion for the configured team and audience. Wrangler's local Access identity simulation is not treated as a signed JWT. The test suite injects a trusted authentication function for API tests; that seam is code-only and cannot be enabled by environment configuration. The current checkout has no verified Access values, so an authenticated browser session has not been demonstrated.

To evaluate the browser panel, authenticate through an already verified Access protected preview and set `T3_MODE=mock` there. Do not set `T3_MODE=live`, create T3 projects/threads, provision a database, deploy, or use guessed endpoints as part of mock setup. This slice uses local browser storage and adds no D1 binding or invented database ID.

Future live activation requires all of the following first:

1. Verify the Access application, issuer/team domain, audience, and approved email/subject policy.
2. Verify the remote T3 API, authentication, polling/reconnect behavior, and project/thread association operations with current first party documentation or an approved integration environment.
3. Configure a server owned mapping in `T3_PROJECTS_JSON`, with exactly one entry per durable GitHub repository ID and matching canonical owner, current repo name, T3 project ID, and absolute workspace root. The Worker checks the mapping against the current GitHub result. Browser requests only contain the GitHub repo ID, never a path.
4. Decide on server durable conversation persistence (for example a deliberately configured D1 binding/migration) before expecting conversations to follow the user across devices. The current localStorage persistence is browser scoped.
5. The read-only pilot is authorized once the existing prerequisites are verified: Access setup and identity policy, supported T3 transport/authentication, and a verified project/workspace mapping. This does not authorize writes or non-read-only actions. Do not request another authorization for that read-only pilot. Deployment is never automatic and is outside this authorization.

## Deploy (once)

1. **GitHub token** – github.com → Settings → Developer settings → Fine-grained tokens.
   Repository access: All repositories. Permissions (read-only): Contents, Pull requests, Metadata.
2. In this folder:
       npx wrangler deploy
       npx wrangler secret put GITHUB_TOKEN
3. **Lock it down (important).** The board shows your private repo names and notes.
   Cloudflare dashboard → Zero Trust → Access → Applications → Add self-hosted app
   for the board's address, policy: allow your own email only.

## Use

Open the board. It refreshes from GitHub at most once a minute; `/?refresh` forces it.
