# Satchel

Satchel saves links to a Notion "Articles" database in one tap, from Chrome and from an iPhone share sheet. The save lands right away. Claude cleans up the title and picks tags in the background a couple of seconds later.

It's a personal tool: one Notion database, two Chrome profiles, one iPhone. The point is that a work Chrome profile can save to a personal Notion, since Satchel never touches the browser's Notion login.

## How it works

```
Chrome extension (popup) ──┐
                           ├─► Cloudflare Worker  POST /save ─► Notion row (200 back to the client)
iOS Shortcut (share) ──────┘                │
                                            └─► waitUntil: title lookup ─► Claude Haiku ─► one patch
```

1. The client sends `{ url, title?, status }` with an `x-satchel-key` header. Status is `later`, `read` or `favorite`.
2. The Worker strips tracking params, then looks for an existing row for that URL.
3. A new URL gets a new row (client title, else a fallback built from the URL). A known URL just gets its status updated.
4. The Worker answers 200 with the row id. The client shows "Saved ✓".
5. In the background, it looks up a real title if needed (oEmbed or the page's `<title>`), asks Claude Haiku for a clean Title Case title and 1 to 3 tags from the existing options, and patches the row once.

Re-saving a URL never re-runs Claude, and the latest status wins.

## Status

**Today: M0 (walking skeleton) in progress. Nothing is deployed yet.**

Merged on `main`:

- Scaffold and guardrails: Worker config, typed env, test harness, gitleaks pre-push hook, deploy and merge scripts (SAT-1).
- URL canonicalization with a strip table and fixtures (SAT-2).
- Notion client over plain `fetch`, with no retry (SAT-3).
- Fallback titles built from the URL (SAT-5).
- Router with key auth, body validation, CORS preflight on `/save` and `/health`, and JSON errors for every code (SAT-4).
- Save handler: dedupe query, then create or patch, with enrich handed to `waitUntil` (SAT-6).
- Title lookups: X via oEmbed with a Twitterbot fallback (SAT-8), page titles via HTMLRewriter with a crawler UA (SAT-10), media via oEmbed (SAT-9).
- Lookups wired into the background enrich: one lookup stage (5 s cap), a re-read, then one patch that writes the looked-up title only if the Name is unchanged since create, and swaps an X URL to oEmbed's canonical only if the URL is unchanged too (SAT-12).
- Keyed `/health` probes Notion, Claude and X oEmbed (503 names the failing one) (SAT-16).
- Claude in the background enrich: tag options read live from the schema, Claude's title and 1 to 3 guarded tag ids in the same one patch (Tags only on an untagged row), a 22 s deadline that abandons Claude, and one re-patch when a tag patch hits a stale cache (SAT-15).

`POST /save` dedupes and creates or patches rows (tested against mocked Notion); the first real-database check is SAT-7. A Notion error returns 502 `notion_<code>` with no retry. After a create, enrich looks up the real title in the background, then Claude Haiku cleans the title (Title Case) and picks 1 to 3 tags from the live Tags options about 2 s after a save; on any Claude failure the looked-up title still lands. A client title goes through Claude too, and a Name edited in Notion since the save is never overwritten. `GET /health` answers keyless liveness; with the key it probes Notion, Claude and X oEmbed (3 s each, in parallel) and returns 503 naming the failing one, and a wrong key gets 401.

Left in M0: the first deploy and real-database check (SAT-7).

Roadmap:

| # | Milestone | What it adds |
|---|---|---|
| M0 | Walking skeleton | A curl save lands in the real database, deduped, with a client or fallback title. Deployed. |
| M1 | Title lookup | X, media and page titles looked up in the background. |
| M2 | Claude enrich and health | Cleaned title and tags about 2 s after a save; keyed `/health` probes Notion, Claude and oEmbed. |
| M2b | Backlog cleanup | Curated tag list, then titles and tags backfilled across the existing rows. |
| M3 | Chrome extension | Popup with Later / Read / ★, options page with Test, failure badge. |
| M4 | iOS Shortcut | Generated, signed Shortcut for the share sheet. |
| M5 | Device test pass | Real saves from Safari, X, Mail and both Chrome profiles, checked in Notion. |
| M6 | Open-source readiness | Deploy-your-own README, MIT, history scan, CI. |

## Repo layout

- `src/index.ts`: the Worker entry and router. Checks the `x-satchel-key` header in constant time, validates the save body, answers CORS preflights and 405s.
- `src/save.ts`: `POST /save`: dedupe query, then create or patch.
- `src/enrich.ts`: the background enrich: lookup stage, Claude slot (empty until M2), re-read, one guarded patch. Never throws; Notion failures log `enrich_failed`.
- `src/title/`: title lookups. `x.ts` (oEmbed, then Twitterbot), `media.ts` (oEmbed), `page.ts` (HTMLRewriter, crawler UA), and `index.ts`, which dispatches by link kind (media falls through to the page read when oEmbed has no title).
- `src/health.ts`: `GET /health`. Keyless is liveness; keyed runs three live probes (Notion data source, Anthropic models list, X oEmbed) and answers 503 when any isn't `ok`.
- `src/contract.ts`: request and response types, error codes, and `json()`, which builds every response.
- `src/canonical.ts`: URL canonicalization, dedupe keys and the Media flag. Pure, no network.
- `src/fallback-title.ts`: the title used when the client sends none.
- `src/notion.ts`: the Notion client. Throws `NotionError` on any failure, never retries.
- `src/tags.ts`: the tag guard. Caches the live Tags options for 10 minutes and maps tag names to option ids (case-insensitive, unknowns dropped, max 3).
- `src/config.ts`: Notion property names (`PROPS`), the pinned Notion API version, and the database IDs.
- `src/log.ts`: one structured log line per event, for Workers Logs.
- `src/claude.ts`: the Claude Haiku call that cleans the title and picks tags with structured outputs. One attempt, 10 s; any failure logs `claude_failed` and returns null.
- `scripts/deploy.sh`: deploys with secrets passed through a private temp file. Prints key names only.
- `scripts/merge.sh`: squash-merges a PR only after an agent review says `Verdict: Ready @ <head sha>`.
- `scripts/stop-check.sh`: the Claude Code Stop hook that runs `npm run check`.
- `test/`: Vitest specs, fixtures, and `network.ts`, which fails any request a test didn't mock.
- `.githooks/pre-push`: runs gitleaks over the commits being pushed.

## Dev setup

You need Node, and gitleaks on your `PATH` (`brew install gitleaks`) so pushes aren't blocked.

```sh
npm ci              # also points git at .githooks
npm run check       # wrangler types, tsc, vitest. Offline, a few seconds.
npx wrangler dev    # local Worker on http://localhost:8787
```

`wrangler dev` reads a gitignored `.dev.vars`. Write it with one filtered grep (never `cat` the secrets file):

```sh
grep -E '^(NOTION_TOKEN|ANTHROPIC_API_KEY|SATCHEL_KEY|NOTION_DATABASE_ID|NOTION_DATA_SOURCE_ID)=' ~/.config/satchel/secrets.env > .dev.vars
```

Tests never read `.dev.vars`. `vitest.config.ts` binds fake values.

## Deploy

`npm run deploy` runs `scripts/deploy.sh`. Secrets, Wrangler auth and the full flow are in [`docs/build/README.md`](docs/build/README.md).

## Design rules worth knowing

- Satchel never retries Notion. A failed save returns 502 `notion_<code>` right away; a background failure logs `enrich_failed` and leaves the row as saved.
- Every response is JSON with an `ok` field, built with `json()` from `src/contract.ts`.
- Tests never hit the network. Any unmocked request fails the test.
- Notion property names live only in `PROPS` in `src/config.ts`, so a fork can remap them in one place.
- No secret, Notion ID or Worker URL is ever committed. The IDs sit in `wrangler.jsonc` as `set-at-deploy`.

## Docs

- [Tech plan](docs/tech-plan.md): decisions D-1 to D-17, risks and milestones.
- [Handoff](docs/handoff.md): the original brief, the Notion schema and the save choices.
- [Build process](docs/build/README.md): branches, PRs, checks, secrets and deploy.
- [Research](docs/research/): Notion, Claude, titles and URLs, Cloudflare, and the Shortcut.

## Keeping this README current

Every PR that changes what works, a command, setup or the repo layout updates the README's Status and the affected section in the same PR.
