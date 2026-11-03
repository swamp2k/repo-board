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

## Optional T3 integration — mock slice only

The default board, Copy Prompt actions, read-only GitHub access and Nexus contract
are unchanged. This branch adds an opt-in **Run in T3** card action and responsive
dialog. It currently records **simulated** conversations, follow-ups and stop
requests; it never starts an agent or contacts T3. It must not be presented as a
working live integration. Missing mappings fail closed.

For a local mock demonstration, supply these bindings to the Worker:

- `T3_MODE`: `mock` (any other value disables the API).
- `T3_API_TOKEN`: a separate ASCII mock-demo password stored as a Worker secret.
  Never use a T3 credential here. HTTP Basic authentication uses username `demo`;
  the browser handles the password, and JavaScript never reads it. Use HTTPS
  outside local development. If a browser does not show the login challenge for
  fetch, navigate to `/api/t3/<githubId>` once to authenticate, then return.
- `T3_STORE`: a KV-compatible binding implementing `get(key, "json")` and
  `put(key, JSON.stringify(value))`. Nothing is provisioned by this change.
- `T3_REPOSITORIES`: JSON array of explicitly checked mappings, for example
  `[{"githubId":123,"owner":"example","repo":"demo","projectId":"mock-demo","workspace":"mock-only","verified":true}]`.
  This example is fictional. Do not claim a real workspace is verified without
  checking its Git remote and T3 project. Card data must match both the GitHub
  database ID and canonical `owner/repo` before the dialog offers a mapping.

The API requires authentication for reads and writes. Writes additionally require
an exact same-origin `Origin` and `X-T3-Request: 1`. Browser requests cannot set
workspace paths, project IDs or proxy destinations. Responses are not cached;
mock board HTML bypasses the shared Worker cache. No live credentials are sent to
the browser. These controls do **not** replace verified Access JWT authorization
for a future live execution surface.

The adapter keys mock conversations by GitHub database ID; updating an allowlisted
name retains them after a rename. Repeated creation requests with the same
`requestId` reuse the saved conversation. This is sequential retry protection,
**not atomic concurrent idempotency**: the mock store uses read/modify/write and
KV can be eventually consistent. Use a transactional store or native T3 thread
persistence for live use. The demo caps each repository at 50 sessions and each
session at 100 messages, and rejects oversized request bodies. Demo messages are
stored solely because there is no real T3 conversation source in mock mode.

The dialog restores selection locally, polls every three seconds, retries errors,
and cancels polling when closed. Mock replies complete immediately; displayed
status is simulated. A stopped mock cannot resume. Actual execution, approvals,
PR activity, streaming, live project creation and live authorization are pending.
Tests exercise client lifecycle with a small DOM harness, **not a mobile browser**.
Run `npm test`; no deployment is needed for the tests.

### Verified T3 investigation (2026-11-03)

Installed `/opt/t3code/t3 --version` and native `t3_environment_read` both report
**0.1.6** (environment Tower). The installed CLI has project add/remove/rename,
thread list/start/send/show, and scoped bearer-session management. The native MCP
catalog exposes project identity/workspace roots, persistent project-filtered
threads, thread launch, incremental message/activity reads, follow-up send,
interrupt, and pending-question handling. The pending-request tool explicitly
excludes approvals; approval presentation/response is not verified or implemented. Native projects are the preferred live
association; no D1 database was introduced because T3 already persists threads.
A future live mapping should pin the GitHub ID to a verified native project,
recheck its canonical remote, and fail closed after a mismatch or rename until
revalidated. Never infer a local checkout from the repository name.

A real unauthenticated initialization POST to
`https://t3.jeppesen.cc/mcp` returned HTTP 401 JSON
`invalid_mcp_credential`. The installed bundled `McpHttpServer` implementation
uses bearer authentication, MCP session/protocol headers and supports
`T3-Mode-Limit` narrowing. Its client bridge accepts JSON and SSE. This verifies
the endpoint and auth rejection, **not authenticated Worker connectivity or
agent-output streaming**. Incremental activity polling is a supported first
choice; MCP SSE alone is not evidence of a thread event subscription.

The public root returned HTTP 200 through Cloudflare without an Access redirect.
That observation does not establish Access application/policy coverage or identity
validation. No Cloudflare configuration or credentials were changed. Verify the
board and every API route's Access audience, issuer, JWT signature, expiry and
allowed identity before enabling live commands. Also verify the chosen T3 client
credential is accepted by `/mcp`; CLI bearer-session availability alone does not
prove that credential works on MCP. Keep the credential server-side, restrict
scopes, enforce approval-required mode, and avoid the CLI's broad default scopes.

The verified T3 project list has **no `swamp2k/glb-viewer` project**, and no
`glb-viewer` checkout was found under `/home/t3code` within four directory levels.
No checkout was guessed, created or modified. Live pilot acceptance is blocked by
an explicit checkout/project mapping, authenticated server-to-server transport,
and verified board API authorization. The next setup step is to identify or
prepare that checkout and register/validate its project, then configure private
credentials and verify a read-only pilot through the actual board. Do not deploy
this branch or change infrastructure as part of that setup without authorization.
