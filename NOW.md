## Where I left off
Doing: Fix native T3 sign-in and live read for the glb-viewer pilot
State: Root cause found: Cloudflare Workers does not support fetch redirect "error" (it throws), so every Worker call to T3 (register, token, MCP) failed as a network error. All T3 fetches now use redirect "manual" and reject 3xx. Deployed and verified live by Martin 2026-11-03: sign-in completes and the glb-viewer conversation list loads. Added step-specific error messages for registration, token and MCP calls, and the T3 panel now opens to show sign-in errors. Tests pass.
Next step: Verify opening a conversation's messages, rate-limit denial, selection restore and disconnect. Then decide on merging PR #3 (still draft). Deploy: npx wrangler deploy --config wrangler.pilot.toml --keep-vars.
Blocked by: Nothing; remaining checks need Martin in the browser.
Updated: 2026-11-03
