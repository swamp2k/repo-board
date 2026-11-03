## Where I left off
Doing: Fix native T3 sign-in and live read for the glb-viewer pilot
State: Root cause found: Cloudflare Workers does not support fetch redirect "error" (it throws), so every Worker call to T3 (register, token, MCP) failed as a network error. All T3 fetches now use redirect "manual" and reject 3xx. Sign-in now completes (connected to T3). Added step-specific error messages for registration, token and MCP calls, and the T3 panel now opens to show sign-in errors. Tests pass.
Next step: Deploy with npx wrangler deploy --config wrangler.pilot.toml --keep-vars, then verify the glb-viewer conversation list and reading a conversation. Keep PR #3 draft.
Blocked by: Deploy and live verification by Martin.
Updated: 2026-11-03
