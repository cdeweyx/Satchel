# Satchel: build handoff

Build **Satchel**, a tiny personal tool that saves links to my Notion reading database from Chrome (two profiles) and my iPhone, with Claude cleaning up titles and picking tags. Repo: https://github.com/cdeweyx/Satchel (private for now, built to go public later).

## Why it exists

- I save articles from email and X. I either read them now (optionally favorite) or save them for later and work through the queue each morning.
- It's a link log, not a reader. I don't want a reading app (I looked at Readwise Reader, Shiori, Instapaper, Raindrop and passed).
- Notion stays the store. The only thing broken is capture: Notion's web clipper is just "Save page" with no options, it's tied to whichever Notion account the Chrome profile is logged into, and mobile is painful.
- The killer problem: I read things in my **work** Chrome profile that I want in my **personal** Notion. Satchel never touches the browser's login, so any profile saves to my personal database.

## Architecture

All saves go through one Cloudflare Worker, which writes to Notion.

Chrome extension (work + personal profiles) ─┐
                                              ├─► Cloudflare Worker ─► Notion "📃 Articles"
iOS Shortcut (share sheet) ──────────────────┘          │
                                                         └─► Claude Haiku (title cleanup + tags)

Standalone Worker, not a route on conordewey.com (decided: keep it separate).

## Notion database (already exists, don't add fields)

- Database: `NOTION_DATABASE_ID` (in the secrets file) ("📃 Articles")
- Data source: `NOTION_DATA_SOURCE_ID` (in the secrets file) (check the current Notion API version; newer versions create pages under a data source, not a database)
- The "Satchel" connection (API token type) needs access to the database: confirm it, and if the API returns 404, tell me to add it via ••• → Connections.

| Property | Type | Satchel writes |
|---|---|---|
| Name | title | Cleaned title |
| URL | url | Canonical URL |
| Tags | multi_select (30 options) | 1 to 3 tags, existing options only |
| Archived | checkbox | Read status (see below) |
| Favorite | checkbox | ★ |
| Media | checkbox | True for YouTube, Vimeo, Spotify, Apple Podcasts and similar |
| Date Added | created_time | Automatic |
| Last Updated | last_edited_time | Automatic |

Existing views: **Inbox** (Archived = false, newest first) and **Archived**. My morning routine is the Inbox view.

### Save choices

| Choice | Archived | Favorite |
|---|---|---|
| Later | false | false |
| Read | true | false |
| ★ Favorite | true | true (★ implies read) |

## Worker

- `POST /save` with JSON `{ url, title?, status: "later" | "read" | "favorite" }` and a `x-satchel-key` header. Reject anything without the right key.
- **Dedupe:** if the URL already exists, update its status instead of adding a row (saving Later, then Read, just moves it).
- **URL cleanup:** strip tracking params (utm_*, fbclid, etc.), normalize twitter.com → x.com, handle the stripped-down links X's share button sometimes passes.
- **Title lookup:** use the passed title if there is one. Otherwise fetch the page's og:title / title / description. For X posts, use X's public oEmbed (`publish.twitter.com/oembed`) to get the author and post text, since x.com blocks scraping.
- **Fast response, AI after:** write the row with the raw title right away and return 200, then use `ctx.waitUntil` to run Claude and patch the row with the cleaned title and tags. The phone banner must not wait on the AI.
- **Claude call:** model `claude-haiku-5-5` (I explicitly chose Haiku for this; don't swap it for Opus). Low effort, structured outputs (`output_config.format`) returning `{ title, tags[] }`. Tags constrained to the live option list read from the Notion schema (cache briefly), 1 to 3 of them, never invent new ones. Title rules: drop site-name suffixes ("| The Acme Blog"), turn X posts into "Author: short gist". Use the official `@anthropic-ai/sdk` TypeScript SDK and run the `claude-api` skill before writing that code. Costs roughly $0.0002 per save.
- If the Claude call fails, leave the raw title and no tags. Never lose a save.
- `GET /health` for a quick check.

## Chrome extension

- Manifest V3. Toolbar button opens a small popup: page title, then **Send to inbox / Mark as archived / Favorite**, with keys `L` / `R` / `F`. A keyboard shortcut opens the popup.
- Options page: Worker URL and Satchel key, stored in `chrome.storage.local` (not `sync`: my two profiles are different Google accounts, so I set it once in each).
- Shows a quick "Saved ✓" and closes.
- Install via "Load unpacked" in both profiles. My work company doesn't block extensions.

## iOS Shortcut

- Four built-in actions: receive URLs / Safari pages from the share sheet → Choose from Menu (Send to inbox, Mark as archived, Favorite) → Get Contents of URL (POST JSON with the key header) → Show Notification "Saved ✓".
- Generate the `.shortcut` file in the repo, sign it on my Mac with `shortcuts sign --mode anyone` (the CLI exists here), and I'll AirDrop it to my phone. If signing fails, give me the manual build steps instead.
- Saving works with the Shortcut alone, no app needed. It should work from Safari, X and Mail.
- The repo copy is a template with no key in it.

## Open source from day one

The repo's private now, but making it public exposes the whole git history, so build as if it's public from the first commit.

- **Secrets:** all secrets are Wrangler secrets (`NOTION_TOKEN`, `ANTHROPIC_API_KEY`, `SATCHEL_KEY`, plus the Notion IDs as vars). `.dev.vars` is gitignored.
- **Config:** Notion property names live in one config file, defaulting to my schema, so anyone can remap them.
- **README:** "deploy your own Satchel in 10 minutes".
- **License:** MIT.
- **Scan:** run gitleaks (or similar) before any push and before going public.

## Secrets

All in `~/.config/satchel/secrets.env` (chmod 600, outside any repo): `NOTION_TOKEN`, `ANTHROPIC_API_KEY`, `SATCHEL_KEY` (pre-generated), `NOTION_DATABASE_ID`, `NOTION_DATA_SOURCE_ID`. Load them into Wrangler from there. Never print them or commit them.

- The Claude key starts with `sk-ant-usr-`, not the usual `sk-ant-api03-`. Test it first. If it's rejected, tell me to create a standard API key at console.anthropic.com.
- I have a fresh Cloudflare account. Wrangler will need me to run `wrangler login` once; ask when you get there.

## Build order

1. Worker: save, dedupe, URL cleanup, title lookup. Deploy, and test with curl against the real database.
2. Claude title and tags step.
3. Chrome extension, loaded in both profiles.
4. iOS Shortcut, generated and signed.
5. Test pass: Safari, X and Mail on iPhone; work profile, personal profile and work browser on desktop. Confirm each row in Notion with the right status, title and tags.
6. README, LICENSE and a secret scan.

## Open questions

- **Separate work browser:** I use one besides Chrome. If it isn't Chromium-based, the extension won't run there, so I'd need a one-click bookmarklet that opens a small save page served by the Worker. Ask me which browser it is.

## Not in v1

- Tag picker in the popup (AI handles tags).
- Saving newsletters by email.
- Pulling ★ favorites into conordewey.com/reading (later; the site's /reading page is a hardcoded list today).
- Highlights or any reader view.