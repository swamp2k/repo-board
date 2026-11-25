## Where I left off
Doing: Edge-case tests for src/worker.js (test/edges.test.mjs)
State: Added test/edges.test.mjs and wired all three test files into package.json on branch test/worker-edge-cases (tests only, no src/ changes). test/board.test.mjs and test/deploys.test.mjs pass; test/edges.test.mjs passes all laneFor, renderBoard, buildBoard, and LF parseNow checks and exposes real parseNow bugs in src/worker.js (Windows CRLF lines are dropped because split("\n") leaves "\r" which regex `.` does not match; whitespace-only "Doing:   " stores "" instead of being ignored). Previous main deploy badge work from 2026-11-08 remains undeployed.
Next step: Review the edge-case tests PR and decide whether to fix parseNow in src/worker.js (CRLF splitting and whitespace-only values) in a follow-up PR; deploy badges on main still await Cloudflare Git build setup or wrangler deploy + CF_API_TOKEN.
Blocked by: none for the tests PR; Cloudflare deploy still needs Martin's login/token.
Updated: 2026-11-26
