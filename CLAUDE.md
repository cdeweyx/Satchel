# Satchel

Satchel saves links to a Notion database in one tap, from Chrome (two profiles) and an iPhone Shortcut. One Cloudflare Worker writes the row fast, then Claude Haiku cleans the title and picks tags in the background.

Plan: `docs/tech-plan.md` (decisions D-1 to D-17, appendix "Rules in full"). Build process: `docs/build/README.md`.

## Stack

- Cloudflare Worker (TypeScript, `wrangler.jsonc`), free plan, Workers Logs on.
- Notion over plain `fetch` (no Notion SDK, ever). Anthropic SDK for Claude, added in M2.
- Tests: Vitest 5 with `@cloudflare/vitest-plugin`, outbound mocks with `msw@3` + `@msw/cloudflare`.

## Commands

- `npm run check`: `wrangler types`, `tsc --noEmit`, `vitest run`. Offline and fast. Must pass before any PR, and the Stop hook runs it.
- `npx wrangler dev`: local Worker on `http://localhost:8787`.
- `npm run types`: regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` (commit it).
- `npm run deploy`: lead only, at deploy gates (see `docs/build/README.md`).

## Standing rules

- Never print, log or commit a secret. Never `cat` the secrets file; grep only the keys you need into a file in one command.
- Satchel never retries Notion (D-10). A sync error returns 502 `notion_<code>` at once; a background failure logs `enrich_failed` and leaves the row as saved.
- No `nodejs_compat` in `wrangler.jsonc` (D-11).
- Tests never hit the network. `test/network.ts` installs a catch-all that fails any unmocked request; mock with `network.use(http.post(url, resolver))`.
- Notion: send `Notion-Version: 2026-03-11` (`NOTION_VERSION` in `src/config.ts`) and create pages under the data source, not the database.
- X oEmbed lives at `publish.x.com`, not `publish.twitter.com`.
- Haiku structured outputs reject `maxItems`, so cap tags (max 3) in code.
- Notion property names come only from `PROPS` in `src/config.ts`. Never spell one inline.
- Every Worker response is JSON with `ok`, built with `json()` from `src/contract.ts`.
- Re-saving a URL never re-runs Claude; the latest status wins.
- Titles are Title Case.
- Strip YouTube `t=` when canonicalizing.

## Branches and PRs (direct mode)

- One issue, one branch off `main`, named with Linear's branch name. One PR into `main` with `Fixes SAT-n`.
- A PR that changes setup, usage, configuration or a command a user runs updates the README in the same PR.
- PR body: the implementer's status report, the tail of `npm run check` on the head sha, `Fixes SAT-n`.
- An agent review posts `Verdict: <...> @ <head sha>`. Only the lead merges, with `scripts/merge.sh <pr>`. Nobody else merges.
- Never rebase or force-push a shared branch. Never push a planted or real secret anywhere.

## This is not evidence

> **This is not evidence.** A claim in a PR body, commit message, or agent report ("green", "tested", "works", "should work", "verified"). A summary of output in place of the output. A check run on any sha but the head. A test that passes because this change touched it (a loosened assertion, an edited golden, a new mock of the thing under test). Type-checks or lint passing, offered as proof of behavior. No console errors, offered as proof a surface renders right. A screenshot of demo or seeded data when the criterion is about real data, or at a width or state the criterion didn't name.
>
> **This is.** The command and the tail of its output on the head sha. A named test that exercises the criterion (and for a bug fix, failed before the fix). A before-and-after number with the command that produced both. A screenshot or recording of the named state at the named width, with real data.
