## Where I left off
Doing: Let Repo Board send follow-up messages into glb-viewer T3 conversations
State: Read-only pilot verified live 2026-11-03 (sign-in, list, answer-first reading). Root cause of earlier failures: Workers does not support fetch redirect "error"; all T3 calls now use "manual". Send support added (not yet deployed): POST /api/t3 calls t3_thread_send (mode queue) after checking the sender is in T3_SEND_EMAILS (Martin's two addresses), the board CSRF token, a T3 grant including orchestration:operate, and that the conversation belongs to the glb-viewer project. UI has a message box, a "Take the next step" shortcut and a click-twice send. Tests pass. The T3 project is now found automatically by its GitHub identity (t3_project_list), so removing and re-adding a repo in T3 no longer needs a config change.
Next step: Re-add glb-viewer in T3, deploy wrangler.pilot.toml, confirm conversations load and sending works. Then consider showing T3 approval requests (t3_pending_request) on the board. Keep PR #3 draft.
Blocked by: Martin's deploy and live test.
Updated: 2026-11-03
