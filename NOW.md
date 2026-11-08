## Where I left off
Doing: Cloudflare deploy badges on every card (Git build / by hand, plus "repo is newer"), also exposed in the Nexus data
State: Committed to main on 2026-11-08, not deployed. npm test passes (board and deploys tests) and wrangler deploy --dry-run builds. Badges stay hidden until the CF_API_TOKEN secret exists. Not yet run against the live Cloudflare API with a real token. This Worker still has no Git build connected, so deploys are manual.
Next step: Martin connects the repo under Workers & Pages > repo-board > Settings > Builds (or runs npx wrangler deploy), creates a read-only Cloudflare token and runs npx wrangler secret put CF_API_TOKEN, then checks the live board for badges. Then deploy Nexus.
Blocked by: creating the token and the authenticated live check need Martin's login.
Updated: 2026-11-08
