# Satchel

Save links to a Notion database in one tap. Satchel is a tiny Cloudflare Worker you deploy yourself. You send it a URL and how you want it filed (read later, read, or favorite), and it writes the row to Notion right away. A couple of seconds later, Claude cleans up the title and picks a few tags from the ones you already use.

It's for people who keep a reading log in Notion and want capture to be fast from anywhere. The Worker holds its own Notion token, so it doesn't care which Notion account your browser is logged into. A work browser can save to a personal database.

## What a save looks like

You send this:

```json
{ "url": "https://example.com/post?utm_source=newsletter", "status": "later" }
```

Satchel answers `{ "ok": true, "id": "<notion page id>" }` in a second or two, and a row shows up in Notion with the tracking params stripped and a placeholder title. Shortly after, the row gets a clean Title Case title and 1 to 3 tags.

| Status | Archived | Favorite |
|---|---|---|
| `later` | off | off |
| `read` | on | off |
| `favorite` | on | on |

Saving a URL that's already in the database just updates its status, so saving it as `later` and then as `read` moves the same row.

## How it works

1. `POST /save` checks the `x-satchel-key` header, cleans the URL, and looks for an existing row.
2. A new URL gets a new row (your title if you sent one, otherwise one built from the URL). A known URL gets its status updated. Then the Worker answers.
3. In the background, it looks up the real title (the page's `<title>`, or oEmbed for X posts, YouTube, Spotify and similar), asks Claude Haiku for a clean title and tags, and updates the row once.

If Claude fails, the looked-up title still lands. If you've edited the title in Notion since saving, Satchel leaves it alone.

## What you need

- **A Notion database** with these properties (names are configurable, types aren't): `Name` (title), `URL` (url), `Tags` (multi-select, with the options you want Claude to pick from), and `Archived`, `Favorite` and `Media` (checkboxes). Satchel never adds tag options or properties.
- **A Notion integration** (internal, from [notion.so/profile/integrations](https://www.notion.so/profile/integrations)), with the database shared to it via the database's ••• menu, then Connections.
- **A Cloudflare account.** The free plan is enough.
- **An Anthropic API key** from [console.anthropic.com](https://console.anthropic.com). Each save costs a fraction of a cent.
- **Node** (a current LTS release) to install and deploy.

## Set up and deploy

1. Clone the repo and install:

   ```sh
   npm ci
   ```

2. Find your two Notion IDs. The database ID is the 32-character string in the database's URL. The data source ID comes from the Notion API:

   ```sh
   curl -s https://api.notion.com/v1/databases/<database id> \
     -H "Authorization: Bearer <notion token>" -H "Notion-Version: 2026-03-11"
   ```

   Use the `id` under `data_sources` in the response.

3. Make a secrets file outside the repo at `~/.config/satchel/secrets.env` (or point `SATCHEL_SECRETS_FILE` at another path), and lock it down with `chmod 600`:

   ```sh
   NOTION_TOKEN=<your Notion integration token>
   ANTHROPIC_API_KEY=<your Anthropic API key>
   SATCHEL_KEY=<a long random string, e.g. from openssl rand -hex 32>
   NOTION_DATABASE_ID=<database id>
   NOTION_DATA_SOURCE_ID=<data source id>
   ```

   `SATCHEL_KEY` is the password every client sends. Keep it private.

4. Log in to Cloudflare once with `npx wrangler login`. For unattended deploys, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to the secrets file instead (make the token from Cloudflare's "Edit Cloudflare Workers" template).

5. Deploy:

   ```sh
   npm run deploy
   ```

   `scripts/deploy.sh` copies only the three secrets into a private temp file, passes the two IDs as vars, and runs `wrangler deploy`. It prints key names, never values. Extra args pass through, so `npm run deploy -- --dry-run` works.

Wrangler prints your Worker URL at the end. Run the same command to redeploy after any change.

## Use it

Save a link with curl:

```sh
curl -s -X POST https://<your worker>/save \
  -H "content-type: application/json" \
  -H "x-satchel-key: $SATCHEL_KEY" \
  -d '{"url": "https://example.com/post", "status": "later"}'
```

The body is `{ "url", "title"?, "status" }`. `title` is optional, and `status` is `later`, `read` or `favorite`.

- **Chrome extension:** coming soon, with Later / Read / ★ buttons in a toolbar popup.
- **iOS Shortcut:** save from the iPhone share sheet. Build and sign it on a Mac with `npm run shortcut`, then follow [the install steps](shortcut/README.md#install-on-your-iphone).

## Configure

- **Property names:** edit `PROPS` in `src/config.ts` to match your database (for example, `Name` to `Title`). It's the only place Satchel names a property.
- **Database and data source IDs:** set at deploy time from your secrets file. `wrangler.jsonc` holds only the placeholder `set-at-deploy`, so the IDs never land in the repo.
- **Tags:** Satchel reads the `Tags` options live from your database, so add or rename options in Notion.

## Troubleshooting

Start with `/health`.

- **No key** (`curl https://<your worker>/health`): `{ "ok": true }` means the Worker is up. That's all it checks.
- **With the key** (add `-H "x-satchel-key: $SATCHEL_KEY"`): Satchel probes its three dependencies in parallel and answers 200 if all pass, 503 if any fails, or 401 if the key is wrong.

| Field | What it checks |
|---|---|
| `notion` | The token can read your data source. |
| `claude` | The Anthropic key works. |
| `oembed` | X's oEmbed endpoint answers (used for X post titles). |

Each field is `ok`, `auth_failed` (bad token or key), `not_found`, or `error <status>` (`error 0` means no response, usually a timeout).

**A save returns 502 `notion_<code>`.** Notion rejected the request, and `<code>` is Notion's own error code. Satchel never retries, so nothing is half-saved and you can just send it again. The common ones:

- `notion_object_not_found`: the database isn't shared with your integration, or an ID is wrong. Share it via ••• then Connections, and check both IDs.
- `notion_unauthorized`: the Notion token is wrong or revoked.
- `notion_validation_error`: a property name or type doesn't match `PROPS` in `src/config.ts`.
- `notion_timeout` or `notion_unreachable`: Notion didn't answer in time. Try again.

**`notion: "not_found"` in `/health`** means the same thing as a 404 from Notion: share the database with the integration.

Other errors are JSON too: 401 `unauthorized` (missing or wrong key), 400 `invalid_body`, `invalid_url` or `url_too_long`.

## Develop

```sh
npm ci              # also points git at .githooks
npm run check       # wrangler types, tsc, vitest. Offline, a few seconds.
npx wrangler dev    # local Worker on http://localhost:8787
```

- `wrangler dev` reads a gitignored `.dev.vars`. Fill it from your secrets file with a filtered grep, so nothing else comes along:

  ```sh
  grep -E '^(NOTION_TOKEN|ANTHROPIC_API_KEY|SATCHEL_KEY|NOTION_DATABASE_ID|NOTION_DATA_SOURCE_ID)=' ~/.config/satchel/secrets.env > .dev.vars
  ```

- Tests never hit the network. Any request a test didn't mock fails it, and tests use fake keys, never `.dev.vars`.
- The pre-push hook runs [gitleaks](https://github.com/gitleaks/gitleaks), so install it (`brew install gitleaks`) or pushes are blocked.

## Contributing

Issues and PRs are welcome. Run `npm run check` before opening a PR, and never commit a secret, Notion ID or Worker URL. The repo's conventions are in [`CLAUDE.md`](CLAUDE.md).

## License

MIT. See [`LICENSE`](LICENSE).
