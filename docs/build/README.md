# Building Satchel

Mode: direct. No milestone branches. Every issue goes straight into `main` through its own PR.

## Branches and PRs

- Branch off a fresh `origin/main`, named with the Linear issue's `gitBranchName` (for example `conordewey3/sat-1-scaffold-worker-repo-harness-and`).
- Open one PR into `main` per issue. The body holds the implementer's status report, the tail of `npm run check` stamped with the full head sha, and `Fixes SAT-n`.
- A PR that changes setup, usage, configuration or a command a user runs updates the README in the same PR.
- An agent review (`pr-review`) posts one PR comment whose first line is exactly `Verdict: <Ready | Ready with fixes | Not ready> @ <head sha>`.
- The lead merges with `scripts/merge.sh <pr>`. It squash-merges only when the base is `main`, the head isn't `main`, the PR has no `needs-human` label, and a comment or review's first line is exactly `Verdict: Ready @ <full 40-char head sha>`. "Ready with fixes" and short shas never match. The user never merges.
- Linear: opening the PR moves the issue to In Review; merging moves it to Done. Waiting on the user is "Waiting on Me".

## Check

```sh
npm run check   # wrangler types --strict-vars=false && tsc --noEmit && vitest run
```

Offline and a few seconds long. The Stop hook in `.claude/settings.json` (`scripts/stop-check.sh`) runs it at the end of every turn and blocks on failure. Type regeneration is part of the check, so drift in `worker-configuration.d.ts` shows up in `git status`.

## Guardrails

- `npm install` runs `prepare`, which sets `core.hooksPath=.githooks`.
- `.githooks/pre-push` runs gitleaks (`.gitleaks.toml`: default rules plus any `sk-ant-` key shape) over the commits being pushed and blocks on a finding. gitleaks must be on `PATH` (`brew install gitleaks`).

## Secrets and deploy

The secrets file lives at `~/.config/satchel/secrets.env`. Never print it, `cat` it, or commit it, and never read keys you don't need.

| Key | Kind | Where it goes |
|---|---|---|
| `NOTION_TOKEN` | Worker secret | `--secrets-file` |
| `ANTHROPIC_API_KEY` | Worker secret | `--secrets-file` |
| `SATCHEL_KEY` | Worker secret | `--secrets-file` |
| `NOTION_DATABASE_ID` | var (not secret, still never committed) | `--var` |
| `NOTION_DATA_SOURCE_ID` | var (not secret, still never committed) | `--var` |
| `CLOUDFLARE_API_TOKEN` (optional) | wrangler auth | exported for wrangler, never sent to the Worker |
| `CLOUDFLARE_ACCOUNT_ID` (optional) | wrangler auth | exported for wrangler, never sent to the Worker |

`wrangler.jsonc` lists the three Worker secrets under `secrets.required`, so `wrangler types` types them on a clean clone and `wrangler deploy` refuses any deploy (including the first) that doesn't carry them. The two IDs sit in `wrangler.jsonc` as the placeholder `set-at-deploy`.

Every deploy runs:

```sh
npm run deploy                 # scripts/deploy.sh
npm run deploy -- --dry-run    # extra args pass through to wrangler deploy
```

`scripts/deploy.sh` greps the three Worker secrets into a `mktemp` file (mode 600, removed on exit), reads the two IDs, and runs `npx wrangler deploy --secrets-file <tmp> --var NOTION_DATABASE_ID:<id> --var NOTION_DATA_SOURCE_ID:<id>`. It prints key names, never values. `SATCHEL_SECRETS_FILE` overrides the file path (use a fake file for proofs). `wrangler secret bulk` is for rotating a secret only, and only ever from the filtered three keys, never the whole secrets file (it also holds the two IDs and `SATCHEL_URL`):

```sh
tmp=$(mktemp) && chmod 600 "$tmp" && grep -E '^(NOTION_TOKEN|ANTHROPIC_API_KEY|SATCHEL_KEY)=' ~/.config/satchel/secrets.env > "$tmp" && npx wrangler secret bulk "$tmp"; rm -f "$tmp"
```

The deployed Worker URL isn't in the repo (it goes public in M6); it's `SATCHEL_URL` in the secrets file.

Wrangler auth, either:

- `npx wrangler login` once (interactive, the user does it), or
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the secrets file, with the token made from Cloudflare's "Edit Cloudflare Workers" template. `deploy.sh` exports them for wrangler only, so deploys run unattended.

Local dev: `wrangler dev` reads `.dev.vars` (gitignored). Write it with one filtered grep, never a `cat`:

```sh
grep -E '^(NOTION_TOKEN|ANTHROPIC_API_KEY|SATCHEL_KEY|NOTION_DATABASE_ID|NOTION_DATA_SOURCE_ID)=' ~/.config/satchel/secrets.env > .dev.vars
```

Tests never use `.dev.vars`: `vitest.config.ts` binds fake values for all five keys.

## Backlog backfill

`scripts/backfill.ts` (SAT-32) runs the live rules over every non-trashed row: Claude's title (the `titled` shape with the current Name and canonical URL; an empty title or a failed call keeps the old one), tags, and the canonical URL. It imports `src/claude.ts`, `src/tags.ts` and `src/canonical.ts` unchanged, so it always uses the live prompt. Runs locally with Node, at most 3 Notion requests a second, no retries except waiting out a 429. Env comes from `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID` and `ANTHROPIC_API_KEY`, loaded with one filtered grep:

```sh
OUT=<workspace>/.context/backfill   # gitignored: these files are personal reading history
tmp=$(mktemp) && chmod 600 "$tmp" && grep -E '^(NOTION_TOKEN|NOTION_DATA_SOURCE_ID|ANTHROPIC_API_KEY)=' ~/.config/satchel/secrets.env > "$tmp" \
  && (set -a; . "$tmp"; set +a; npm run backfill -- --dry-run --out "$OUT"); rm -f "$tmp"
```

- `--dry-run --out <dir> [--tags=fill-empty|union]`: writes nothing to Notion. Writes `<dir>/plan.jsonl` (one line per row that changes: page id, archived flag, old and new title, tags and URL) and `<dir>/duplicates.json`, then prints 20 examples (title changes and tag fills, Inbox and Archived), the counts, Claude's cost from token usage, and elapsed time.
- `--tags=fill-empty` (default): tags already on a row stay exactly as they are; only rows with zero tags get Claude's 1 to 3. `--tags=union`: every row keeps all its tags and gains Claude's missing ones while it has fewer than 3.
- Duplicates (rows whose canonical URL or dedupe key matches another row's) are listed in `duplicates.json` and left out of the plan: never merged, deleted or written.
- `--apply <dir>/plan.jsonl --out <dir>`: writes only the rows in the plan and only the properties that change (Name, Tags by option id through `guardTags`, URL). It re-reads each page right before writing it: a row whose Name, Tags or URL changed since the dry run (or that was trashed) is skipped, logged as `skipped: changed since dry run` and counted in the summary. Otherwise the fresh values go to `<dir>/rollback.jsonl` before the write. A plan tag that doesn't map to a Tags option stops the run before anything is written.
- `--rollback <dir>/rollback.jsonl`: writes the logged old values back, newest line first.

## Gates (the build stops for the user here)

- M0: SAT-7, after SAT-6. User runs `wrangler login` (or adds the Cloudflare token to the secrets file), confirms the Worker URL, opens `/health` in the work Chrome profile and checks Developer mode is available. On a Notion 404, stop and add the Satchel connection via ••• → Connections.
- M2: SAT-17.
- M2b: SAT-31 (tag list approval), SAT-33.
- M3: SAT-22.
- M4: SAT-26.
- M5: SAT-27.
- M6: SAT-30.
