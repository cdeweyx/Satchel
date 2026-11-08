# Lane 1: Notion read/write for the Worker

Date: 2026-11-07. All probes READ-ONLY against the real "Articles" data source. Probe scripts in `.context/probes/notion/` (`schema.sh`, `sample_urls.sh`, `query_equals.sh`, `query_or.sh`, `timing.sh`).

## Answer

- **Pin `Notion-Version: 2026-03-11`** (released Mar 11, 2026, the latest). Both it and `2025-09-03` work against our data source today (probe, HTTP 200). The SDK still defaults to `2025-09-03`, so pin explicitly.
- **The "Satchel" connection already has access.** Retrieve data source and query both returned 200. Schema matches the handoff exactly: Name (title), URL (url), Tags (multi_select, 30 options), Archived, Favorite, Media (checkbox), Date Added (created_time), Last Updated (last_edited_time).
- **Create pages under the data source**: `parent: { "type": "data_source_id", "data_source_id": "<id>" }`. Query is `POST /v1/data_sources/{id}/query`; schema is `GET /v1/data_sources/{id}`. Never use `/v1/databases/{id}/query` (legacy, breaks if a second data source is ever added).
- **Dedupe with one compound `or` query** (4 clauses: `equals canonical`, `starts_with canonical+"?"`, `starts_with canonical+"#"`, `equals raw` when it differs). Probed: catches all old clipper rows with tracking params, including a doubled-URL row, in 1 request at ~0.3 s. 11 of 25 recent rows carry query params; zero twitter.com rows exist.
- **Tags: write by option `id`, never by `name`.** A new name silently creates a new option when the connection can write (doc). Filter Claude's output against the cached live option set and map to ids; unknown id is a `validation_error`, not a new option.
- **Use plain `fetch`, not `@notionhq/client`.** Four endpoints, one ~40-line typed wrapper with a Retry-After loop. The SDK would run on Workers (zero deps, global fetch, `node:http` is a type-only import) but adds a dependency for nothing we need.

## Verified table

| Claim | Rung | Result | Source | Feeds |
|---|---|---|---|---|
| Latest API version is `2026-03-11` | doc | Changelog entry "New API version 2026-03-11" dated Mar 11, 2026; versioning page's placeholder is broken but examples use it | https://developers.notion.com/page/changelog (2026-11-07), https://developers.notion.com/reference/versioning (2026-11-07) | Version pin |
| `2026-03-11` and `2025-09-03` both work on our DB | probe | Retrieve data source 200 with each header | `schema.sh` | Version pin |
| `2026-03-11` breaking changes don't touch our calls | doc | Three changes: `after` → `position` on block children, `archived` → `in_trash`, `transcription` → `meeting_notes` | https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11 (2026-11-07) | Version pin |
| Connection has access; schema as specified | probe | 200; 8 properties, types match handoff; Tags has 30 options; data source parent is database `b456e0c8-...` | `schema.sh` | Setup step (no ••• → Connections fix needed) |
| Create page parent shape for a data source | doc | `{"type":"data_source_id","data_source_id":"..."}`; `type` optional; works on any API version | https://developers.notion.com/reference/post-page (2026-11-07), upgrade guide 2025-09-03 | Create row |
| Query endpoint and URL filter conditions | doc + probe | `POST /v1/data_sources/{id}/query`; url supports `equals`, `does_not_equal`, `contains`, `does_not_contain`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty`; compound `or` works | https://developers.notion.com/reference/query-a-data-source (2026-11-07), `query_equals.sh`, `query_or.sh` | Dedupe |
| `equals` is case-insensitive, exact otherwise | probe | `HTTPS://WWW.MAKINGSOFTWARE.COM/` matched; `https://www.makingsoftware.com` (no slash) did not | `query_equals.sh` | Dedupe, URL canonicalization |
| Compound OR lookup catches old clipper rows | probe | 4 of 4 known rows found (utm, `_bhlid`, `?s=46&t=`, doubled `?access_token` JWT); never-saved URL returns 0 | `query_or.sh` | Dedupe |
| Recent rows: 11/25 carry params, 0 twitter.com, slashes mixed | probe | utm_* (6), `_bhlid`/`aid` (4), `s=&t=` on x.com (1), `access_token` (1); `contains "twitter.com/"` → 0 rows; `starts_with "https://x.com/"` → 5+ rows | `sample_urls.sh`, `query_equals.sh` | URL cleanup rules |
| Read latency | probe | Retrieve 0.23 to 0.30 s; query 0.26 to 0.33 s (3 runs each) | `timing.sh` | Worker response budget |
| PATCH shapes: title, checkbox, multi_select, url | doc | `{"Name":{"title":[{"text":{"content":"..."}}]},"Archived":{"checkbox":true},"Tags":{"multi_select":[{"id":"..."}]},"URL":{"url":"..."}}`; arrays replace fully; omitted props untouched | https://developers.notion.com/reference/patch-page (2026-11-07) | Update row |
| New multi_select name creates an option | doc | "A new option name adds an option to the schema if your connection can write to the parent data source" | https://developers.notion.com/reference/page-property-values (2026-11-07) | Tag guard |
| Rate limits | doc | 180 req / 60 s per connection on non-Business plans (~3 r/s), spendable as a burst; separate ~3 r/s on Query a data source; a shared per-workspace limit on top; 429 `rate_limited`, `Retry-After` ≤ 60 s, repeated as `additional_data.retry_after`; 529 `service_overload` treated like 429 | https://developers.notion.com/reference/request-limits (2026-11-07), changelog Sep 9 and Sep 24, 2026 | Retry logic |
| Size limits | doc | URL 2000 chars; rich text `content` 2000 chars; multi_select 100 options; payload 500 KB; violations are 400 `validation_error` | https://developers.notion.com/reference/request-limits (2026-11-07) | Input guards |
| Error body shape | probe | `{"object":"error","status":404,"code":"object_not_found","message":"...shared with your integration \"Satchel\".","request_id":"...","additional_data":{...}}`; missing header → 400 `missing_version` | `timing.sh` session (bogus id), status codes doc | Error handling |
| `@notionhq/client` runs on Workers | repo | v5.31.1 (2026-11-06): zero deps, no runtime Node imports in `build/`, only `import type { Agent } from "node:http"` in `Client.d.ts`; README says Cloudflare Workers aren't treated as browsers; accepts custom `fetch`; retries 429/529 (all methods) and 500/503 (GET/DELETE only) up to 2 times by default | npm registry + unpacked tarball in `.context/probes/notion/sdk_pkg/`, https://raw.githubusercontent.com/makenotion/notion-sdk-js/main/README.md (2026-11-07) | SDK vs fetch |
| Old versions keep working | doc + probe | "No current plans to stop supporting older versions"; `2022-06-28` `/databases/{id}/query` still returns 200 on our DB today | versioning page (2026-11-07), `timing.sh` | Month-three risk |
| Version cadence | doc | 2025-09-03 (announced Aug 26, 2025), 2026-03-11, and an unnamed next version announced Oct 30, 2026 (markdown endpoints only) | changelog (2026-11-07) | Month-three risk |

## Recommendations

**1. Version pin: `2026-03-11`.** One-way for the build (changing it later is a one-line edit, but shapes in code follow it). Runner-up `2025-09-03`: identical for our four calls, but it's one version behind on day one and the SDK's default would mask the choice. Nothing in `2026-03-11` touches pages-in-data-sources, so there's no cost.

**2. Dedupe lookup: one compound `or` query, pick the oldest match.** Two-way. Filter: `equals canonical`, `starts_with canonical+"?"`, `starts_with canonical+"#"`, plus `equals raw` only when raw differs. Sort `created_time ascending`, `page_size 5`, update `results[0]`. Cost: 1 request per save on the query limit (~3 r/s), ~0.3 s. Runner-up `contains host+path`: also 1 request and catches the same rows, but `contains "site.com/post"` also matches `site.com/post-2` and `/post/reply`; the `starts_with canonical+"?"` form never over-matches. Canonical-only `equals` is the wrong answer: it missed 3 of 4 probed clipper rows.

**3. Tag guard: filter names against the live schema, then write by `id`.** One-way. Retrieve data source, build `Map<name, id>`, cache in a module-level variable with a ~10 minute TTL (one extra request per cold isolate, no KV). Drop any Claude tag not in the map (exact, case-sensitive match), cap at 3, send `multi_select: [{id}]`. By-id can't create an option; by-name can. Runner-up: by-name after filtering. Works today but one bug in the filter creates junk options in the user's schema.

**4. HTTP client: plain `fetch`.** Two-way. One `notion(path, init)` helper: sets `Authorization`, `Notion-Version`, `Content-Type`; on 429/529 sleeps `Retry-After` (cap 60 s, max 2 retries); on 5xx for writes does NOT retry blindly (a 503 may have saved the row; the create would duplicate). Runner-up `@notionhq/client@5.31.1` with `notionVersion: "2026-03-11"`: would run on Workers and brings typed `dataSources.query`/`pages.create` plus built-in retries, but it's a CJS package with no `exports` map and a 60 s default timeout, and we'd still wrap it. Four endpoints don't justify the dependency.

**5. Write-then-patch plan per save.** Request count: 1 query (dedupe) + 1 create or patch (sync, before 200) + 0 to 1 retrieve (cached schema) + 1 patch (background, title and tags) = 3 to 4 requests, ~1 s of Notion time total. Comfortably inside 180/min.

## Gotchas

- Header is `Notion-Version: 2026-03-11`. Missing it is 400 `missing_version`, not a default.
- Trailing slash matters to `equals`; case doesn't. Canonicalize by stripping tracking params and fragments only. Don't add or remove trailing slashes (the DB has both forms, matching what each site served).
- Tracking params seen in the real data: `utm_*`, `_bhlid`, `aid`, `publication_id`, `post_id`, `isFreemail`, `r`, `triedRedirect`, x.com `s` and `t`, stratechery `access_token`. One row is the same URL concatenated twice (clipper bug); the `starts_with canonical+"?"` clause catches it.
- Rows saved as Later have 0 tags; the user adds tags on read. On a dedupe hit, patch only `Archived`/`Favorite`. Never resend `Tags` or `Name` (arrays replace fully).
- Multi_select PATCH replaces the whole array. The background Claude patch should write Tags only if the row still has 0 tags, or it clobbers a manual edit made in the gap.
- Error body: `{object:"error", status, code, message, request_id, additional_data}`. 404 `object_not_found` message literally says "shared with your integration \"Satchel\"". 403 `restricted_resource` can also mean a Free workspace hit its block limit (REST enforces it since Sep 1, 2026).
- URL property max 2000 chars, title `content` max 2000 chars. Truncate title; reject or trim URLs over 2000 (a doubled JWT URL in the DB is already ~1200).
- `page_size` default is small; always set it. Query results cap at 10,000 with `request_status.type: "incomplete"`, irrelevant for a page_size 5 lookup.
- `archived` is renamed `in_trash` on `2026-03-11`. We don't trash rows; don't read `archived` from responses either.
- The data source's `parent` in responses is `{type:"database_id", database_id:"b456e0c8-48bb-4c89-9ee4-aa606fc05261"}` (hyphenated). IDs come back hyphenated; the un-hyphenated form in config is accepted on requests.

## Month-three failure question

Notion ships a new `Notion-Version` only for backwards-incompatible changes: four in 2021 to 2022, then none until `2025-09-03`, then `2026-03-11` six months later, and one more announced Oct 30, 2026 (markdown endpoints default to v2; doesn't touch pages, queries, or data sources). Additive changes reach every version immediately. Old versions keep working: `2022-06-28` still queries our DB today (probe). The only way a pinned integration breaks is a data-model change that the old version can't express, and the one on record is multi-source databases: an integration on `2022-06-28` fails the moment a second data source is added to a DB. Pinned to `2026-03-11` with data-source-shaped calls, the realistic month-three risk is nil. The thing to watch is the changelog's "next Notion-Version" entry and the unverified gap below.

## Still unverified

- **SDK actually executing in `workerd`** (needs probe rung if the plan picks the SDK; moot under the plain-fetch recommendation). Evidence is repo-level only: no runtime Node imports, type-only `node:http`.
- **Dates for the 2021 and 2022 versions** (doc rung; changelog fetch truncated before those entries). Only `2021-05-13` is named on the versioning page.
- **Workspace plan and per-workspace rate limit number** (doc gives no figure; plan unknown). Matters only if other connections in the workspace are busy.
- **Create and PATCH shapes against the real DB** (probe rung; forbidden this lane, write calls). Build step 1's first curl should be the verification.
- **Whether `multi_select: [{id}]` with an unknown id returns `validation_error` rather than silently dropping** (probe rung; write call). Doc implies it; confirm in build step 1 against a scratch page, then archive it.

## What this means for the plan

Treat Notion as settled: version `2026-03-11`, four plain-fetch calls, data-source parent, one-request compound dedupe, tags by id. The build agent's step 1 should begin by running the write-side verifications listed above against one scratch row.
