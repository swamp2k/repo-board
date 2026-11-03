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

## Optional T3 workspace panel

The T3 panel has two explicit modes. `T3_MODE=mock` is a simulator; it does not contact T3 and keeps simulated conversations in this browser's `localStorage`. `T3_MODE=live` enables native T3 OAuth and a read-only conversation browser for the verified `swamp2k/glb-viewer` project only. Other repositories never get a live T3 button. The live panel can list conversations and read a selected conversation. It has no live send, resume, cancel, create, or agent-launch operation.

### Live access requirements

Live mode fails closed until all of these deployment values and bindings exist:

- Existing Cloudflare Access protection for the board, with `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and an approved email or subject allowlist. The OAuth callback also requires the same signed Access identity.
- `BOARD_ORIGIN`, the fixed HTTPS origin of the board. HTTP is allowed only for `localhost`, `127.0.0.1`, or `[::1]` during loopback development. This is used to construct the exact OAuth redirect and reject requests with a different host or origin.
- `T3_AUTH_STORE`, a Durable Object scoped by a hash of the verified Access subject and a random browser cookie. Each browser gets an independent opaque Secure, HttpOnly, SameSite=Lax cookie and CSRF token. The object stores that browser's short-lived single-use PKCE transaction and native T3 access token. No live messages or tokens are stored in browser storage.
- `T3_RATE_LIMITER`, a Workers Rate Limiting binding. Missing or failed rate limiting blocks live OAuth and read requests.
- `T3_PROJECTS_JSON`, the server-side mapping shown in `wrangler.live.example.toml`. It pins GitHub's verified node ID `R_kgDOUSfguQ` to T3 project `mcp:6ccdf28e-d941-4b71-a636-a344020b5643` and workspace `/projects/glb-viewer`. T3 project/thread responses are checked against this mapping before messages are returned.

The Worker registers a public OAuth client with T3, uses authorization code + S256 PKCE, and exchanges codes only at the fixed `https://t3.jeppesen.cc/oauth/mcp/token` endpoint. Every callback must contain exactly one `iss` parameter equal to `https://t3.jeppesen.cc`; a validated OAuth error callback consumes its pending state without exposing T3's error text. T3's approval page determines the granted scope; the Worker saves a token only when the returned scope is exactly `orchestration:read`. Any broader or missing scope is rejected. T3 grants read access across its environment; Repo Board enforces the narrower glb-viewer restriction itself. The token expiry comes from `expires_in`; there is no refresh token flow. Disconnect deletes the board's local credential. To revoke the native T3 grant, use T3's Sharing & Access settings.

The MCP transport is fixed to `https://t3.jeppesen.cc/mcp` and allowlists only `t3_project_read`, `t3_thread_list`, and `t3_thread_read`. Project repository identity is checked against T3's `repositoryIdentity.canonicalKey` and `rootPath`, when present. Native thread list/read envelopes are normalized by their `threadId`, `items`, `nextCursor`, `nextPosition`, and `hasMore` fields. Requests limit a page to 50 conversations or 100 message items and 10,000 characters per item; the panel exposes Load more controls and labels truncated item text. Redirects, arbitrary URLs, browser-supplied paths, and every write/agent-control action are rejected. No D1 database or T3 project/thread is created by this feature.

### Local browser evaluation

1. For a UI preview, set `T3_MODE=live`, `BOARD_ORIGIN=http://localhost:8787`, and local Access settings in private `.dev.vars`; run `npx wrangler dev --port 8787`. The glb-viewer card and read-only panel render locally.
2. Local requests still require a real signed Cloudflare Access JWT, the Durable Object binding, and a rate limiter. The Worker does not simulate or bypass Access, so a plain local browser session cannot complete OAuth or read conversations. To complete those steps, use an already Access-protected HTTPS board preview with its origin in `BOARD_ORIGIN`, verified Access values, and configured bindings.
3. On that protected preview, select **glb-viewer → T3 conversations** and choose **Connect to T3**. Approve exactly read-only access on T3's approval page. The app returns to the board and reopens the glb-viewer panel; it shows the conversation list and loads messages only after selecting a conversation.
4. Use **Disconnect** to remove the board's local stored credential. Revoke the T3 grant separately in T3 Sharing & Access if needed.

This checkout has not completed a real OAuth exchange or real conversation read. The Workers configuration example is illustrative and contains a numeric sample rate-limit namespace ID (`1001`); choose an account-unique numeric ID before use to avoid sharing counters with another Worker. It does not provision a rate-limit namespace or deploy anything. Never configure a localhost redirect in production. OAuth permits HTTP redirects only for loopback development hosts.

### Verification and pilot status

- `npm test` passes, including native response fixtures, Access verification, state/issuer/browser binding, read-only isolation, pagination, and UI races.
- Wrangler 4.157.0 dry-run builds pass for both the disabled default configuration and the live example. No upload or deployment was performed.
- Browser checks at 320px and 1280px pass for layout, conversation selection, Escape, close/reopen selection restore, and disconnect. These used injected UI test responses, not authenticated T3 data.
- The real T3 registration endpoint returned HTTP 201. Anonymous MCP access returns 401. An authenticated OAuth approval and real conversation read remain unverified.
- The deployed Repo Board Worker was inspected read-only: only `GITHUB_TOKEN` is bound. It has no live T3 configuration, credential store, or rate limiter. The existing board URL redirects to Cloudflare Access login.

The next acceptance step requires approval for a read-only pilot deployment behind the board's existing Access protection, with its verified identity allowlist, the auth-store migration, and a rate-limit binding. Then sign in through T3 and approve Read only. No new Cloudflare Access application for T3 is required by this approach.

Rollback: disable `T3_MODE` and revoke the Repo Board grant in T3's Sharing & Access settings. Disconnect removes this browser's board credential but does not revoke the native grant. Retain the private auth namespace until cleanup is explicitly approved; disabling the feature does not delete infrastructure.

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
