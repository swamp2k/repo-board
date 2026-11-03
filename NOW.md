## Where I left off
Doing: Let Repo Board send follow-up messages into glb-viewer T3 conversations
State: Read-only pilot verified live 2026-11-03 (sign-in, list, answer-first reading). Root cause of earlier failures: Workers does not support fetch redirect "error"; all T3 calls now use "manual". Send support added (not yet deployed): POST /api/t3 calls t3_thread_send (mode queue) after checking the sender is in T3_SEND_EMAILS (Martin's two addresses), the board CSRF token, a T3 grant including orchestration:operate, and that the conversation belongs to the glb-viewer project. UI has a message box, a "Take the next step" shortcut and a click-twice send. Tests pass.
Next step: Deploy wrangler.pilot.toml, Disconnect, reconnect choosing Auto-accept edits on T3's screen, then send one message and confirm T3 picks it up. Keep PR #3 draft.
Blocked by: Martin's deploy and live test.
Updated: 2026-11-03
