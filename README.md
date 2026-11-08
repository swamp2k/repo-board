# Repo Board

One card per GitHub repo, sorted into lanes from each repo's `NOW.md` and open PRs.

Lanes:
- **Waiting for review** – the repo has an open PR
- **In progress** – has a NOW.md, touched within 14 days
- **Paused** – has a NOW.md, untouched for more than 14 days
- **No bookmark yet** – no NOW.md, touched within 30 days
- **Gathering dust** – no NOW.md, untouched for more than 30 days (collapsed)

Cards fade the longer they go untouched. "Resume" copies a prompt to paste into Claude Code or Codex.

It only reads from GitHub (and, if you add the token, from Cloudflare). It never writes to your repos.

## Deploy (once)

1. **GitHub token** – github.com → Settings → Developer settings → Fine-grained tokens.
   Repository access: All repositories. Permissions (read-only): Contents, Pull requests, Metadata.
2. In this folder:
       npx wrangler deploy
       npx wrangler secret put GITHUB_TOKEN
3. **Deploy badges (optional).** Cloudflare dashboard → My Profile → API Tokens → Create custom token.
   Permissions (read-only), this account only: Pages Read, Workers Scripts Read, Workers CI Read. Then:
       npx wrangler secret put CF_API_TOKEN
   Each card then shows where its repo is deployed: Git build or by hand. Leave it out and nothing changes.
4. **Lock it down (important).** The board shows your private repo names and notes.
   Cloudflare dashboard → Zero Trust → Access → Applications → Add self-hosted app
   for the board's address, policy: allow your own email only.

## Use

Open the board. It refreshes from GitHub at most once a minute; `/?refresh` forces it.
