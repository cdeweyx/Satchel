# Satchel tech plan

Decided 2026-11-07 after two critic rounds and the user review. L1 to L5 are the research reports (Notion, Claude, titles and URLs, Cloudflare, Shortcut); the word after is the rung. Detail sits in the appendix toggle "Rules in full".

## 1. Problem and link

The Notion web clipper saves to whichever account the Chrome profile holds, and mobile capture is painful. Satchel is one Cloudflare Worker: a Chrome popup or iOS share sheet sends a URL and status, it writes a row to the "📃 Articles" database, and Claude Haiku tidies title and tags after. Product doc: [lean product doc](https://app.notion.com/p/412f974853cf80ac9a32cb93fd6edbd4).

## 2. Constraints

- Cloudflare free plan: under 3 ms CPU a save against a 10 ms cap (L4 probe). Claude about $0.00012 a save (L2 probe).
- Single user, two Chrome profiles, one iPhone. Forkable: no secret in git, property names in one module.
- Agent-built; every milestone has a check the agent runs alone.
- Design fixed: popup shows page title then Later / Read / ★ (keys L / R / F), flashes "Saved ✓", closes. Shortcut: menu, then notification. Brand precedes the extension.
- User calls: Notion down fails visibly, never retried. Re-save never re-runs Claude; latest status wins. All Chrome. Haiku 5.5. No new fields.

## 3. Scenarios

**Work Chrome, a newsletter post.** Press R in the popup; the service worker posts URL and tab title. The Worker strips `utm_*`, finds no row, creates one with Archived true, returns 200 under a second. "Saved ✓". Two seconds later Claude has cut the site suffix and picked two tags.

**iPhone, the X app.** Share a post, pick Later. The Shortcut sends the URL (with `?s=46&t=...`) and a title equal to the URL. The Worker reduces it to the post id, finds no row, creates one titled "@naval on X". JSON `ok`, "Saved ✓". Then oEmbed gives author and text, Claude writes "Naval: short gist", a tag lands.

**Re-save, Later to Read.** A day later, Read from the phone. The dedupe query finds the row; Archived and Favorite follow the latest status. No Claude, no new row, hand-added tags stay.

**Saturday, the Anthropic key has expired.** The row lands with the looked-up title, no tags; the banner said "Saved ✓". The enrich task gets a 401, logs one line, stops. The user spots the untagged row, hits Test in options, reads "Claude: key rejected", rotates the secret.

## 4. System context and data flow

```
Chrome popup (work / personal) ──┐                      ┌─► Notion data source (query, create, patch, schema)
                                 ├─► POST /save ─► Worker ─┤
iOS Shortcut (share sheet) ──────┘       │              ├─► oEmbed endpoints, page HTML
                                         │              └─► Anthropic Messages (claude-haiku-5-5)
curl, /health ───────────────────────────┘
```

One save: auth → parse → canonicalize (no fetch) → dedupe query → create or patch → **200** → `waitUntil`: title lookup if needed → Claude → re-read → one patch.

## 5. Components and what each requires

| Component | Inputs | Outputs | Needs |
|---|---|---|---|
| Router and auth | request, key header | JSON `ok` on every code, preflight | `crypto.subtle.timingSafeEqual` |
| Canonicalizer | raw URL | canonical URL, kind, dedupe filter | `URL`, strip table |
| Notion client | path, body | typed responses, no retry | `fetch`, version `2026-03-11` |
| Title lookup | canonical URL, kind | raw title | oEmbed, HTMLRewriter |
| Enricher and tag guard | raw title, URL, schema | title, option ids (max 3) | `@anthropic-ai/sdk`, cache |
| Health | key or none | liveness or probes | no state |
| Chrome extension | tab title, URL, key | POST via service worker, badge | MV3, `storage`, `activeTab` |
| iOS Shortcut | share item, menu pick | POST, notification | generator, signing |

## 6. Data model

The Notion data source is the store, one row per canonical URL, plus an in-memory cache.

| Property | On create (sync) | On dedupe hit (sync) | By enrich (async) |
|---|---|---|---|
| Name | client title, else fallback | never | Claude's title, else looked-up, else unchanged; only if unchanged since create |
| URL | stored form (below) | never | oEmbed canonical, X only |
| Tags | empty | never | 1 to 3 option ids, only if still empty |
| Archived, Favorite | from status | from status | never |
| Media | from host list | never | never |

Stored URL: canonical, host lowercased, `m.` and `mobile.` dropped, `www.` as given. The dedupe query matches both host forms with equals, `?`, `#` and trailing-slash clauses, plus the raw URL: 9 clauses in one `or`. X uses the post id; oldest match wins. The background task ends in one patch after a re-read, since PATCH replaces `multi_select` wholesale (L1 doc).

## 7. Decisions

### D-1 Split the save into a sync write and a background enrich

- Serves: criteria 1, 2.
- Context: Notion write 0.6 to 0.8 s (L1 probe); Claude 0.9 to 1.5 s (L2 probe); page fetch to 1.9 s (L3 probe).
- Options: (a) all sync; (b) Notion write sync, rest after; (c) title lookup sync, Claude after.
- Decision: facing a 1.5 s budget, we chose (b) over (c), keeping every call but Notion off the response path, accepting a slug title for two seconds.
- Why: a blocked site would stall the banner on a 403, and Claude recovers the title from the slug. The response path is one Notion query and one write, no outbound fetch; the save promise also goes to `waitUntil` so a disconnect can't cancel it.
- Rejected (a): one write; 3 to 4 s banner, lost save if Claude hangs; reopens never.
- Rejected (c): the handoff read literally; slowest third party before the banner; reopens if fallback titles grate.
- Door: one-way. Confirm by: M0 boundary test.
- Status: revised round 1, 2026-11-07: one background patch, looked-up title if Claude fails. Revised round 2, 2026-11-07: wrapper following cut; 22 s deadline, 24 s worst case; save promise in `waitUntil`.
- Status: decided (user review, 2026-11-07).

### D-2 Dedupe on a canonical key with one compound query

- Serves: criterion 1.
- Context: 11 of 25 recent rows carry tracking params; slash and X forms vary (L1 probe).
- Options: (a) `equals canonical`; (b) `or` of `equals`, `equals + "/"`, `starts_with + "?"`, `starts_with + "#"` for both host forms, plus `equals raw`; X by `contains "/status/<id>"`; (c) `contains host + path`.
- Decision: facing un-normalized rows, we chose (b) over (c), catching old rows without over-matching, accepting a non-atomic query-then-create.
- Why: (b) found 4 of 4 clipper rows in one 0.3 s request (L1 probe); the id match folds every X form into one post (L3 probe). A hit patches status only.
- Rejected (a): simplest; missed 3 of 4 clipper rows; reopens after a bulk clean.
- Rejected (c): one clause; `site.com/post` matches `site.com/post-2`; reopens never.
- Door: one-way. Confirm by: M0 curl of a clipper URL returns its id; `m.`, `www.` and bare fixtures dedupe to one row.
- Status: revised round 1, 2026-11-07: stored URL, both-host clauses.
- Status: decided (user review, 2026-11-07).
- Status: revised in build, 2026-11-08 (SAT-6): X hits are post-filtered to an exact id (the `contains` clause also matches longer ids); a stored URL with a query uses `starts_with + "&"` instead of `+ "?"`; a bare root URL's `+ "/"` clause uses the slashless form.

### D-3 Order the title chain and define the fallback title

- Serves: criterion 1.
- Context: Spotify, TikTok and NYT serve `og:title` to a crawler UA only; Medium and Bloomberg block all; YouTube oEmbed beats a 1.4 MB page (L3 probe).
- Options: (a) client title else page fetch; (b) client title (empty or URL-equal is missing) → lookup by kind → fallback; (c) always fetch.
- Decision: facing uneven bot blocking, we chose (b) over (c), using the browser's title when present and the cheapest source otherwise, accepting a host table.
- Why: the client title is the only signal on paywalled pages. X via `publish.x.com` oEmbed (the handoff's `publish.twitter.com` 301s there, L3 probe), then Twitterbot `og:description`; media via oEmbed; pages via HTMLRewriter. Fallback: `@user on X` or `X post <id>`, else de-slugged path and hostname.
- Rejected (a): fewest paths; 1.4 MB YouTube pages, nothing from X; reopens never.
- Rejected (c): consistency; loses Safari's title where we can't fetch; reopens if client titles are noisy.
- Rejected fxtwitter and iTunes lookup (round 1): extra M1 paths; `X post <id>` and HTML cover them; reopen if the debug route disagrees.
- Door: one-way for fallback shape and UA; chain order two-way. Confirm by: M1 fixtures and the debug route over L3 URLs.
- Status: revised round 1, 2026-11-07: fxtwitter and iTunes cut.
- Status: decided (user review, 2026-11-07).

### D-4 Fix the /save contract, CORS and auth

- Serves: criterion 5.
- Context: an extension origin without `host_permissions` uses normal CORS (L4 doc); the Shortcut branches on the body (L5).
- Options: (a) `Allow-Origin: *`, preflight, `x-satchel-key` header, JSON `{ok, id?, error?}`; (b) `host_permissions` for `*.workers.dev`; (c) key in body or query.
- Decision: facing two clients and a user-set URL, we chose (a) over (b), so one contract works everywhere, accepting a wildcard origin.
- Why: the key header is the auth; preflight carries no credentials. Body `{url, title?, status}`. Every response is JSON with `ok`: 200, or 400 / 401 / 404 / 405 / 500 / 502 with `error`. `OPTIONS` 204. `/health` keyless is liveness; keyed, probes; wrong key, 401.
- Rejected (b): no preflight; breaks on a custom domain; reopens never.
- Rejected (c): simpler Shortcut; keys in logs; reopens never.
- Door: one-way. Confirm by: M0 curl of each code; M3 saves from both profiles.
- Status: revised round 1, 2026-11-07: keyless liveness, keyed probes. Revised round 2, 2026-11-07: every response JSON with `ok`; wrong key on `/health` is 401.
- Status: decided (user review, 2026-11-07).
- Status: revised in build, 2026-11-08 (SAT-4): `OPTIONS /health` → 204 with `Allow-Methods: GET, OPTIONS`, since the extension's Test button preflights its keyed GET.

### Two-way doors (full records in the appendix)

- D-5 Canonicalize in code: hardcoded strip table, not ClearURLs; Google and Facebook targets read from the query; no redirect following (reopen: M5 saves land as wrapper rows) (L3).
- D-6 Tag guard: filter against the live schema, map to ids, cap 3 (L1 doc).
- D-7 Shortcut: generated template, signed to a gitignored file, import questions with a Text fallback; "Saved ✓" only on JSON `ok: true`; manual steps if signing fails (L5 probe).
- D-8 Claude call: raw JSON schema, live enum, `effort: "low"`, one attempt, 10 s; on failure the looked-up title stands (L2 probe).
- D-9 Keyed `/health` live-probes Notion, Anthropic and oEmbed; keyless is liveness; options Test shows it in words; no KV (L2 wanted it; criterion 4).
- D-10 Plain `fetch` for Notion, pinned `2026-03-11`; never retries: sync error is 502, background failure logs `enrich_failed` (L1).
- D-11 Omit `nodejs_compat`; the SDK runs without it (L2 probe; L4 suggested it).
- D-12 Vitest 5, `@cloudflare/vitest-plugin`, MSW catch-all, `waitOnExecutionContext` (L4 probe).
- D-13 MV3 popup, options page and a service worker that owns the fetch, so closing the popup can't drop a save; red "!" badge on a failure after close.
- D-14 Secrets via `wrangler secret bulk`, IDs as vars, gitleaks hook from M0 (L4).
- D-15 Property names in one module; Tags read live.
- D-16 Media host list from L3; X, Instagram out.
- D-17 Workers Logs on, one line per enrich outcome.

## 8. Risks

| # | Risk | Mitigation | Signal |
|---|---|---|---|
| 1 | Cloudflare egress gets more 403s than the laptop (L3 unverified) | Fallback title, Claude; M1 debug route | Slug titles |
| 2 | X oEmbed dies or changes | Twitterbot `og:description`, then `X post <id>` (L3 probe) | `/health` `oembed` |
| 3 | Anthropic key expires (L2 doc) | Key verified in L2; rotate with one secret put | `claude: auth_failed` |
| 4 | `waitUntil` hits 30 s | Every fetch timed; Claude once, 10 s; 22 s deadline; 24 s worst case | `enrich_deadline` |
| 5 | Import questions don't fire on iOS 26 | Text fallback; README follows | Empty key, 401 |
| 6 | Two taps, two rows | Accept; buttons disable on press | Two rows |
| 7 | Work profile blocks `workers.dev` or Load unpacked | M0 check; reopens: custom domain, packed extension | `/health` won't load |
| 8 | Fallbacks hide quality drift; slug and "X post" titles look normal | Accepted; reopen: a lookup probe in keyed `/health` | Slug or "X post" titles in Inbox or M5 |

**The five ways this bites**

1. `<title>` split across chunks, or no `og:title` in 256 KB. Fixture, M1.
2. Enum casing drift or a tag renamed mid-cache. Test, M2.
3. The user edits Name or Tags in the gap. Re-read; test, M2.
4. Title equal to URL from X or Mail. Fixture, M0.
5. The Worker URL changes. Options page, Shortcut question; M5 check.

## 9. Open questions

Product doc: **separate work browser** (its only question), resolved: Chrome only. D-1 title-first: decided (user, 2026-11-07): fallback title first, the real one about 2 s later; the spec had lookup before the write. Raised here, ranked by impact:

1. Does Cloudflare's egress get blocked where the laptop wasn't? M1 debug route; if so, the popup sends `og:title`.
2. Do import questions fire on iOS 26? M4 on device; sets the README's lead install path.
3. Keep YouTube `t=` timestamps? Resolved (user, 2026-11-07): strip.
4. Title casing? Resolved (user, 2026-11-07): Title Case.
5. Anthropic key? Resolved (user, 2026-11-07): keep the verified `sk-ant-usr-` key; a later 401 shows on `/health`.

## 10. Milestones

Every Worker milestone runs typecheck and tests plus the check below.

| # | Milestone | Done state | Effort / driver | Check | User acts |
|---|---|---|---|---|---|
| M0 | Walking skeleton | curl save lands in the real database, deduped, client or fallback title; contract, config, harness, deploy; gitleaks hook and secrets gitignore before first push | L / cross-layer integration | L3 fixtures; `m.` / `www.` / bare dedupe; JSON `ok` on each code; clipper URL returns its id; no PATCH before response; hook blocks a fake secret | `wrangler login`; confirm URL; in the work profile open `/health` and check Developer mode, else stop; on Notion 404, stop and add the connection via ••• → Connections |
| M1 | Title lookup | X, media and page lookups in `waitUntil`; one patch writes the title; debug route | M / external API | Fixtures per kind incl. chunked `<title>`; debug route over L3 URLs, results in PR | None |
| M2 | Claude enrich and health | Cleaned title and tags by id about 2 s after a save; failures keep the looked-up title; keyed `/health` | M / external API | Fake tag filtered, max 3; mocked 401 leaves the row, `/health` 503; a real save tagged | On 401, stop and mint a standard key at console.anthropic.com |
| | *Brand step (lead, via brand-design; not a milestone): SVG mark, PNG icons 16 / 32 / 48 / 128, Shortcut glyph and colour, CSS custom properties. M3 blocks on it; M4 needs glyph and colour only.* | | | | |
| M3 | Chrome extension | Popup, options with Test, service worker owning the save, failure badge, shortcut, brand assets | M / cross-layer integration | Loads unpacked; save from each profile; save and close at once, row lands; wrong key, popup closed, badge shows; Test shows per-field words | Load unpacked in both profiles; set URL and key |
| M4 | iOS Shortcut | Generator, signed file, import questions plus fallback, "Saved ✓" only on JSON `ok: true`; manual steps if signing fails | M / no check on device | Template assertion (action ids, key header, empty key default, `ok` branch); output starts `AEA1`; gitleaks clean | AirDrop; Add Shortcut |
| M5 | Device test pass | Safari, X, Mail; both Chrome profiles; rows checked | S / ambiguity | 8 saves with Notion ids in PR; wrong key first; no error lines | All |
| M6 | Open-source readiness | README, MIT, history scan, CI | S / no runnable check | gitleaks 0 over history; fresh clone reaches `/health` | Flip public |

## 11. Deliberately left out

- Notion retry or queue, re-running Claude, a bookmarklet (user calls).
- KV, cron, Durable Objects (criterion 4).
- Tag picker, email newsletters, favorites to conordewey.com, reader view (product doc).
- Redirect-wrapper following (reopen if M5 lands wrapper rows); a custom domain, unless the M0 work-profile check fails.
- The official X API (paid, L3 doc).

## 12. How we'll know

- M0: a curl row appears in Inbox; a second curl moves it.
- M1: a YouTube save shows its title in 3 s; an X save, author and text.
- M2: cleaned title and tags in 3 s; keyed `/health` 503 on a bad key.
- M3: a work-profile save lands, popup closed.
- M4: an X app share lands as Later, "Saved ✓".
- M5: 8 of 8 rows right, no error lines.
- M6: a fresh clone reaches `/health`.

## Appendix

<details>
<summary>Decision records, two-way doors</summary>

### D-5 Canonicalize in code with a hardcoded strip table and wrapper list

- Serves: D-2, the handoff's URL cleanup.
- Context: ClearURLs holds 206 providers in 106 KB; about 15 params matter to this reading list (L3 repo). Following every redirect turns `youtu.be` into a `?si=` URL and paywalls into login pages (L3 probe).
- Options: (a) ship ClearURLs rules; (b) hardcoded strip table (global exact, global prefix, per-host), no network; (c) strip `utm_*` only.
- Decision: facing a personal tool on a 10 ms CPU budget, we chose (b) over (a), to get a dependency-free layer with a 20-row fixture table, accepting a code edit per new tracker.
- Why: rules from L3 verbatim (Rules in full). Host lowercased, path case kept, fragment and trailing slash dropped, `http` upgraded, trailing `?` dropped. X reduces to `x.com/i/status/<id>`; `i/web/status` is rewritten because oEmbed 404s on it (L3 probe). No redirect following in v1 (round 2): the popup sends the final tab URL, tapping a Mail link on iOS opens Safari on the final URL (L3), and X shares x.com links. `google.com/url`, `l.facebook.com` and `out.reddit.com` targets are read from the query param without a fetch. Reopen: M5 Mail or X saves land as t.co, substack.com/redirect or beehiiv rows. Substack's `r` and `s` stripped only on Substack hosts or when `utm_source=substack` is present.
- Rejected (a): full coverage; 106 KB and a regex engine on the response path; reopens if unknown trackers start producing duplicates.
- Rejected (c): ten lines; `_bhlid`, `fbclid`, X's `s` / `t` all become duplicates, each seen in the real data (L1 probe); reopens never.
- Door: two-way (old rows stay findable through D-2's compound query). Confirm by: L3 fixtures pass in M0.
- Status: proposed (round 0, 2026-11-07); revised round 2, 2026-11-07: wrapper following cut; param-read wrappers only.
- Status: decided (user review, 2026-11-07).

### D-6 Guard tags by writing option ids from a live schema cache

- Serves: criterion 1 (no junk tag options), the handoff's "existing options only".
- Context: a new multi_select name silently creates an option when the connection can write (L1 doc). The Anthropic API rejects `maxItems` (L2 probe) and may change enum casing (L2 doc).
- Options: (a) write by name after filtering; (b) filter case-insensitively against the cached schema, map to ids, `slice(0, 3)`, write by id; (c) hardcode the 30 names in config.
- Decision: facing an API that can't enforce "at most 3", we chose (b) over (a), to make a junk option impossible even with a filter bug, accepting one schema retrieve per cold isolate.
- Why: by-id is a different failure class; an unknown id is a 400, not a schema change. The same cache feeds the Claude enum, so prompt and guard can't drift. On a `validation_error` from the tag patch, refresh the cache once and retry, covering a tag renamed in Notion mid-cache. Match returned names case-insensitively, then write the option id.
- Rejected (a): readable payloads; one bug away from 31 options; reopens never.
- Rejected (c): zero schema reads; forkers edit config for every tag and stale names fail; reopens never.
- Door: two-way (code only; the harm it prevents is one-way, which is why it ships in M2 with its own test). Confirm by: M2 test where Claude returns a fake tag and the PATCH body holds only known ids, max 3.
- Status: proposed (round 0, 2026-11-07).
- Status: decided (user review, 2026-11-07).

### D-7 Generate the Shortcut from a script and sign on release

- Serves: the handoff's "repo copy has no key".
- Context: a Python generator plus `shortcuts sign --mode anyone` produced a file Shortcuts.app accepted; signing needs network and a cert good for about 13 months; the signed payload is encrypted (L5 probe). Import questions are documented but unverified on iOS 26 (L5 doc).
- Options: (a) generator writes an unsigned template with placeholders, signing writes a gitignored output, import questions for URL and key with the first two Text actions as fallback; (b) hand-build in the app and export; (c) runtime "Ask for Input".
- Decision: facing a public repo, we chose (a) over (b), to keep the file reviewable and keyless, accepting a 4 s network step at release and a re-sign every year.
- Why: an exported file is opaque, so a leaked key would be invisible. Always send `title`; the Worker treats empty or URL-equal titles as missing (D-3). Show "Saved ✓" only when the response is JSON with `ok: true` (round 2); anything else shows "Satchel: not saved" plus the `error` value, or "unexpected response" when there isn't one, so a 404, 500, body-less 405 or Cloudflare HTML page can't read as success. The key default is empty so a skipped prompt hits a visible 401 rather than saving nothing. Don't commit the signed file; re-sign and re-AirDrop is the month-13 fix.
- Rejected (b): no code; an unreviewable binary in git; reopens if signing fails: manual build steps in the README.
- Rejected (c): no import step; a tap per save; reopens never.
- Door: two-way (regenerate and re-AirDrop any time). Confirm by: M4 check that the signed output starts with `AEA1` and the template passes gitleaks; device test with a wrong key first.
- Status: proposed (round 0, 2026-11-07); revised round 1, 2026-11-07: option (b) reopens when signing fails; M4 carries the manual-build path.
- Status: revised round 2, 2026-11-07: success only on JSON `ok: true`; agent-run structural assertion on the template; M4 is M.
- Status: decided (user review, 2026-11-07).

### D-8 Shape the Claude call and fail soft

- Serves: criterion 6, the handoff's Claude step.
- Context: `claude-haiku-5-5` with `output_config.format` works; `effort: "low"` gave zero thinking tokens on 8 of 8 calls, 0.9 to 1.5 s, $0.00012 a save (L2 probe). `waitUntil` cancels at 30 s (L4 doc).
- Options: (a) raw JSON schema (`minItems: 1`, `enum` = live tags), `effort: "low"`, `max_tokens: 512`, SDK `timeout: 10_000`, `maxRetries: 0`; (b) `zodOutputFormat` with `messages.parse()`; (c) prompt-only JSON.
- Decision: facing a 30 s background window, we chose (a) over (b), to get a six-line schema with a dynamic enum and a bounded wall clock, accepting a grammar recompile each time the tag list changes.
- Why: Zod adds a dependency and passes `maxItems` through to the same 400 (L2 repo). Read the text block by `type`, since Haiku can emit a thinking block first (L2 doc). Any `stop_reason` other than `end_turn`, any thrown error, or a parse failure means: log one structured line (class, status, request id, never the key) and leave the row as written. No `fallbacks`, no `temperature`; both 400 on Haiku 5.5 (L2 doc). System prompt from L2; titles in Title Case (user, 2026-11-07). Catch order: `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `APIConnectionError`, then `APIError` (L2).
- Rejected (b): typed output; a dependency for no gain; reopens if the schema grows.
- Rejected (c): zero API features; parse failures and invented tags; reopens never.
- Door: two-way (code only; the "never lose a save" promise is enforced by D-1's ordering). Confirm by: M2 test where a mocked 401 leaves Name and Tags untouched and the save still returned 200.
- Status: proposed (round 0, 2026-11-07); revised round 1, 2026-11-07: timeout 8 s so two attempts fit the 25 s deadline; on failure Name takes the looked-up title.
- Status: revised round 2, 2026-11-07: one attempt, `maxRetries: 0`, `timeout: 10_000`; abandoned at the 22 s stage deadline.
- Status: decided (user review, 2026-11-07).

### D-9 Make enrich failures visible without state

- Serves: criteria 4 and 6. Lanes disagree: L2 wants KV; criterion 4 says no KV unless forced.
- Context: Workers Logs keep 3 days free (L4 doc). A KV namespace is one more binding every forker creates.
- Options: (a) KV `last_error` shown on `/health`; (b) `/health` runs live probes (Notion schema retrieve, Anthropic models list with the key, X oEmbed on a known post), per-save failures to Workers Logs only; (c) logs only, `/health` always 200.
- Decision: facing a tool used a few times a day, we chose (b) over (a), to show the three month-three failures on demand with no new binding, accepting that a transient enrich failure older than 3 days leaves no trace except the untagged row. `GET /health` without the key returns `{ok: true}` liveness only; with the key it runs the probes. A public probing endpoint would share Notion's 180 a minute limit with saves and anyone could burn it.
- Why: the user checks `/health` after seeing an untagged row, and a live probe answers "is it broken now", which is the real question. The models endpoint costs no tokens. The Notion row is the durable evidence of a failed enrich. `/health` returns 503 when any probe fails, with the failing field named. The options page Test button calls the keyed `/health` and shows each field in plain words ("Notion: ok", "Claude: key rejected", "X oEmbed: down"); a 401 shows "Key rejected", a network error "Can't reach Worker". A phone or browser tab never needs to type the key.
- Rejected (a): history; a KV namespace in the deploy steps and writes per save; reopens if the user wants a count of failed enriches.
- Rejected (c): nothing to build; oEmbed dying unnoticed until Inbox fills with "X post 1234"; reopens never.
- Door: two-way (adding KV later is additive). Confirm by: M2 test that `/health` returns 503 with `claude: "auth_failed"` when the models call is mocked 401, and `{ok: true}` without the key.
- Status: proposed (round 0, 2026-11-07); revised round 1, 2026-11-07: keyless liveness, keyed probes, options Test surfaces the result.
- Status: revised round 2, 2026-11-07: wrong key on `/health` is 401; Test words for 401 and network errors.
- Status: decided (user review, 2026-11-07).

### D-10 Use plain fetch for Notion, pinned to 2026-03-11

- Serves: criterion 4.
- Context: four endpoints (retrieve data source, query, create page, patch page). `@notionhq/client` 5.31.1 would run on Workers but is CJS with no `exports` map, a 60 s default timeout, and defaults to `2025-09-03` (L1 repo).
- Options: (a) plain `fetch` wrapper, no retry on the sync path; (b) the SDK with `notionVersion` set.
- Decision: facing four endpoints, we chose (a) over (b), to drop a dependency and own the retry policy, accepting hand-typed response shapes.
- Why: the wrapper is about 40 lines. It sets `Authorization`, `Notion-Version`, `Content-Type`. On the response path it never retries: any error, including 429 / 529, returns 502 `notion_<code>` at once, so Notion down fails visibly inside the budget. Background calls (schema, re-read, enrich patch) don't retry either (round 2): a failure logs `enrich_failed` and leaves the row as saved. One rule everywhere: Satchel never retries Notion. Pin `2026-03-11`; its breaking changes (`position`, `in_trash`, `meeting_notes`) touch none of our calls (L1 doc). Create under `data_source_id`, never the legacy database query (L1 doc). Set `page_size: 5`, sort `created_time` ascending.
- Rejected (b): types and built-in retries; a dependency and a masked version default; reopens if the call count grows past ten.
- Door: two-way. Confirm by: M0 first curl against a scratch row, then archive it; a mocked 429 on create returns 502 with no sleep.
- Status: proposed (round 0, 2026-11-07); revised round 1, 2026-11-07: Retry-After loop removed from the sync path.
- Status: revised round 2, 2026-11-07: no background retry either; `enrich_failed`.
- Status: decided (user review, 2026-11-07).

### D-11 Omit nodejs_compat

- Serves: criterion 4. Lanes disagree: L2 probed without it; L4 recommended it in its config sketch.
- Context: `wrangler deploy --dry-run` bundled the Anthropic SDK with only a compatibility date, and `wrangler dev --local` served a real call (L2 probe). The only `node:` string in the bundle is an error message (L2 probe).
- Options: (a) omit; (b) include.
- Decision: facing a flag nothing needs, we chose (a) over (b), to keep the runtime surface small and surface any accidental `process.env` use as a build error, accepting a one-line edit if a future dependency wants it.
- Rejected (b): not thinking about it; hides Node-isms that don't belong in a Worker; reopens the day a dependency imports `node:*` at runtime.
- Door: two-way. Confirm by: M0 deploy.
- Status: proposed (round 0, 2026-11-07).
- Status: decided (user review, 2026-11-07).

### D-12 Pick the test stack

- Serves: criterion 3.
- Context: `@cloudflare/vitest-pool-workers` is deprecated; the replacement is `@cloudflare/vitest-plugin` 1.6.0 on Vitest 4.1+ or 5.x. `fetchMock` is gone; outbound mocking is `msw@3` plus `@msw/cloudflare`. Full run about 3.7 s (L4 probe). Unmocked requests pass through to the real network with only a warning (L4 probe).
- Options: (a) plugin + Vitest 5 + MSW with a catch-all error handler; (b) pin Vitest 4.1; (c) inject `fetch` and `vi.fn()` it.
- Decision: facing deprecated recipes everywhere online, we chose (a) over (c), to mock at the network edge where the Anthropic SDK also lives, accepting one `skipLibCheck` in the TypeScript config.
- Why: the catch-all (`http.all("*")` returning a network error) means a test can never hit Notion or Anthropic for real. Per-test handlers added later take precedence (standard MSW ordering; L4 marks the exact ordering unverified, a two-minute probe in M0). The boundary test uses `createExecutionContext` and `waitOnExecutionContext`. Fixture tables: L3's 20 URLs, L1's dedupe shapes, L2's five prompt inputs. Assert the Anthropic request's `authorization: Bearer` header, not `x-api-key` (L4 probe).
- Rejected (b): caution; an older Vitest for no shown bug; reopens if 5.x breaks.
- Rejected (c): no MSW; threading `fetch` through every module and the SDK; reopens never.
- Door: two-way. Confirm by: M0 harness.
- Status: proposed (round 0, 2026-11-07).
- Status: decided (user review, 2026-11-07).

### D-13 Shape the Chrome extension

- Serves: the design handoff (popup, options, shortcut).
- Context: MV3. The popup can read the active tab's title and URL with `activeTab`, granted when the user invokes the action or its command. Settings live in `chrome.storage.local` because the two profiles are different Google accounts (handoff). CORS is handled by the Worker (D-4).
- Options: (a) popup + options, no service worker, `_execute_action` command, plain JS; (b) service worker owning the fetch, popup as a thin view; (c) a bundler and a framework.
- Decision (revised round 2): facing a popup the user closes at once, we chose (b) over (a), so the request outlives the popup, accepting one small background script and a badge state.
- Why: `_execute_action` opens the popup from the keyboard with no code. The popup queries the active tab, renders the title, listens for L / R / F and clicks, disables the buttons on first press (risk 6), and hands the save to the service worker, which makes the request. If the popup is still open it shows "Saved ✓" for about 600 ms then closes, or "Couldn't save, try again" and stays open. Success means JSON with `ok: true`, same rule as the Shortcut. If the save fails after the popup closed, the service worker sets a red "!" badge on the toolbar icon until the next successful save. With no URL or key configured it shows a link to the options page. Icons and CSS tokens come from the brand step; the popup uses only those tokens for colour, radius and type.
- Rejected (a), popup owns the fetch: zero background code; closing the popup mid-save drops it silently; reopens never.
- Rejected (c): component reuse; a toolchain for two pages; reopens never.
- Door: two-way. Confirm by: M3 load unpacked in both profiles; save and close the popup at once, the row lands; wrong key with the popup closed shows the badge.
- Status: proposed (round 0, 2026-11-07); revised round 2, 2026-11-07: service worker owns the fetch; badge on failure after close.
- Status: decided (user review, 2026-11-07).

### D-14 Handle secrets and deploy

- Serves: criterion 5.
- Context: `wrangler secret bulk` accepts a dotenv file or stdin with nothing echoed and deploys a new version at once (L4 doc + probe). The secrets file holds five values; only three are secrets.
- Options: (a) filter the three secret keys into `secret bulk`, put the two IDs as vars in the Wrangler config; (b) bulk all five as secrets; (c) `secret put` per key.
- Decision: facing a file with mixed sensitivity, we chose (a) over (b), to keep the IDs visible in the dashboard and typed by `wrangler types`, accepting a one-line grep in the deploy step.
- Why: run `secret bulk` after the first deploy, not before. For local dev, the same filtered grep writes the local dev vars file in one command, never a `cat`. Gitignore: local dev vars, any `.env`-style file, the probe directory, the signed Shortcut output. Gitleaks runs as a pre-push hook installed in M0 before the first push, and once over full history in M6. Wrangler config in JSONC (Cloudflare's recommendation, L4 doc) with `observability.enabled: true`.
- Rejected (b): one command; IDs hidden from the dashboard and untyped; reopens never.
- Rejected (c): explicitness; three interactive steps; reopens never.
- Door: two-way. Confirm by: M0 deploy plus `wrangler types --check`; the hook blocks a planted fake secret.
- Status: proposed (round 0, 2026-11-07); revised round 2, 2026-11-07: hook and gitignore land in M0.
- Status: decided (user review, 2026-11-07).
- Status: revised in build, 2026-11-07 (SAT-1): `secrets.required` in wrangler.jsonc means the first deploy must carry secrets; every deploy runs `scripts/deploy.sh` (filtered `--secrets-file` plus `--var` for the two IDs); `secret bulk` is for rotation only.

### D-15 Keep property names in one config module

- Serves: criterion 5.
- Context: the handoff asks for one config file defaulting to this schema so a fork can remap.
- Options: (a) one exported object of property names plus the two IDs read from env; (b) environment variables per property name; (c) read the schema and guess by type.
- Decision: facing forkers with different column names, we chose (a) over (c), to make remapping a five-line edit with a type check, accepting a redeploy on change.
- Why: Tags options are read live from the schema (D-6), so a fork's tag vocabulary needs no config at all. The media host list and strip table stay in code tables, not config; they're rules, not identity.
- Rejected (b): no-code remap; eight more vars and no types; reopens if someone wants to remap without a redeploy.
- Rejected (c): zero config; ambiguity with three checkboxes; reopens never.
- Door: two-way. Confirm by: M0 typecheck.
- Status: proposed (round 0, 2026-11-07).
- Status: decided (user review, 2026-11-07).

### D-16 Set the Media host list

- Serves: the Media column.
- Context: the handoff says "YouTube, Vimeo, Spotify, Apple Podcasts and similar".
- Options: (a) L3's list including TikTok, Twitch, Overcast, Pocket Casts, SoundCloud; (b) the four named hosts only.
- Decision: facing a vague "and similar", we chose (a) over (b), to cover the audio and video hosts a reading list actually meets, accepting a judgment call on TikTok.
- Why: match on hostname after `www.` and `m.` strip, exact or suffix. X excluded even with video. Instagram excluded; most saves there would be posts.
- Rejected (b): literalness; podcasts from Overcast unchecked; reopens if TikTok saves turn out not to be media in practice.
- Door: two-way. Confirm by: M0 fixture.
- Status: proposed (round 0, 2026-11-07).
- Status: decided (user review, 2026-11-07).

### D-17 Observe with Workers Logs

- Serves: criterion 6.
- Context: Workers Logs free tier is 200,000 events a day with 3-day retention; pricing changes Dec 1, 2026 (L4 doc). `wrangler tail --status error` works on free (L4 probe).
- Options: (a) logs on, one structured line per enrich outcome; (b) paid 7-day retention; (c) nothing.
- Decision: facing a few saves a day, we chose (a) over (b), to make a failed enrich a one-line search, accepting a 3-day window.
- Why: the Notion row is the durable evidence; logs explain it. Log `{event: "enrich", pageId, ok, error}`, `enrich_failed` when a background Notion call fails, and `enrich_deadline` when the 22 s stage deadline abandons Claude.
- Rejected (b): history; $5 a month; reopens if 3 days keeps proving too short.
- Rejected (c): nothing; blind debugging; reopens never.
- Door: two-way. Confirm by: M2 tail during a forced failure.
- Status: proposed (round 0, 2026-11-07); revised round 2, 2026-11-07: `enrich_failed` added, deadline at 22 s.
- Status: decided (user review, 2026-11-07).

</details>

<details>
<summary>Rules in full (detail cut from the body)</summary>

**Response path budget (D-1, revised round 2).** Auth and parse: microseconds. No outbound fetch: one dedupe query (about 0.3 s, L1 probe) plus one create or patch (0.3 to 0.5 s). Target under 1.5 s, always. Satchel never retries Notion, sync or background: a sync error returns 502 `notion_<code>` at once; a failed background call logs `enrich_failed` and leaves the row as saved. The save promise is also passed to `waitUntil`, so the Notion write completes even if the client disconnects. Background task: every fetch has its own timeout (each lookup fetch 4 s, the whole lookup stage capped at 5 s; schema retrieve 3 s; Claude one attempt, `maxRetries: 0`, `timeout: 10_000`; re-read 3 s; patch 3 s). Stage deadline at 22 s: if Claude hasn't returned, abandon it, log `enrich_deadline`, and write the looked-up title (if any) in the final patch. Bounded worst case: 5 + 3 + 10 + 3 + 3 = 24 s, under Cloudflare's 30 s cancel (L4 doc). The task ends in ONE patch: Name = Claude's title if Claude succeeded, else the looked-up raw title if lookup succeeded, else unchanged, always guarded by "Name unchanged since create"; Tags only if still empty; URL to oEmbed canonical for X. In M1, before Claude exists, that patch writes the looked-up title.

**Canonicalization (D-5), from L3.** Global exact strip: `fbclid gclid dclid gbraid wbraid msclkid twclid ttclid yclid igshid igsh mc_cid mc_eid mc_tc mkt_tok _hsenc _hsmi __hsfp __hssc __hstc hsCtaTracking vero_id vero_conv oly_anon_id oly_enc_id _ga _gl srsltid cmpid ncid ref_src ref_url __twitter_impression wickedid rb_clickid ml_subscriber ml_subscriber_hash s_cid triedRedirect isFreemail`. Global prefix: `utm_ mtm_ pk_ ga_ itm_ otm_ hsa_`. Per host: x.com `s t cn src ref`; youtube.com / youtu.be `si feature pp kw app ab_channel` `t` (user, 2026-11-07); spotify.com `si nd dlsi context pi`; medium.com `source sk gi`; substack.com `r s publication_id post_id showWelcomeOnShare` (also when `utm_source=substack` on any host); podcasts.apple.com `l uo at ct itscg itsct ls`; nytimes.com `smid referringSource` (keep `unlocked_article_code`); tiktok.com `_r _t is_from_webapp sender_device web_id`; reddit.com `share_id rdt`. Structure (revised round 1): lowercase host, drop `m.` and `mobile.`, keep `www.` exactly as the source had it (this is the stored URL), keep path case, drop fragment, drop trailing slash on non-root paths, upgrade `http`, drop a trailing `?`. X: accept `twitter.com`, `mobile.twitter.com`, `x.com`, `fxtwitter.com`, `vxtwitter.com`, `fixupx.com`; match `/(?:i\/web\/status|i\/status|[A-Za-z0-9_]{1,15}\/status(?:es)?)\/(\d+)`; drop `/photo/1` and the like. YouTube: `youtu.be/<id>`, `/shorts/<id>`, `m.youtube.com` all become `youtube.com/watch?v=<id>`. Wrappers (round 2): no redirect following. `l.facebook.com/l.php` reads `u`, `google.com/url` reads `q` or `url`, `out.reddit.com` reads `url`, all in-process. t.co, substack.com/redirect, list-manage, beehiiv, convertkit, lnkd.in, bit.ly stay as given; the named reopen is M5 saves landing as those rows. Dedupe filter: for each of the two host forms (bare and `www.`) four clauses (`equals`, `equals + "/"`, `starts_with + "?"`, `starts_with + "#"`), plus `equals raw`: 9 clauses in one flat `or`. X uses a single `contains "/status/<id>"`. Fixture rows added in round 1: `https://m.nytimes.com/2025/01/27/technology/deepseek.html`, `https://www.nytimes.com/2025/01/27/technology/deepseek.html` and `https://nytimes.com/2025/01/27/technology/deepseek.html` all dedupe to one row; stored forms are `https://nytimes.com/...` for the first and third and `https://www.nytimes.com/...` for the second, and whichever saved first stays. The 20-row fixture table in L3 section 6 plus these three is the test file.

**Title lookup (D-3), from L3.** Missing title: empty, whitespace, or equal to the raw or canonical URL. X: `GET https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2Fi%2Fstatus%2F<id>&omit_script=true&dnt=true`; require `content-type` JSON; raw title `${author_name}: ${first <p> inner text, entity-decoded}`; store `oembed.url` as the row URL. Fallback 1: fetch `https://x.com/i/status/<id>` with UA `Twitterbot/1.0`, read `og:title` (display name before ` (@`) and `og:description`. No fxtwitter fallback (cut in round 1; the `X post <id>` fallback covers it, and fxtwitter is the named reopen). Only for `/status/` URLs. Media: YouTube `https://www.youtube.com/oembed?format=json&url=`; Spotify `https://open.spotify.com/oembed?url=`; Vimeo `https://vimeo.com/api/oembed.json?url=`; TikTok `https://www.tiktok.com/oembed?url=`; SoundCloud `https://soundcloud.com/oembed?format=json&url=`; Apple Podcasts, Overcast and Pocket Casts: HTML like any page (round 1 cut the iTunes lookup; the M1 debug route confirms `og:title` comes back for Apple Podcasts, and the iTunes lookup is the named reopen if not). Pages: UA `Mozilla/5.0 (compatible; Satchel/0.1; +https://github.com/cdeweyx/Satchel) facebookexternalhit/1.1`, `Accept: text/html,*/*;q=0.8`, `Accept-Language: en-US,en;q=0.9`, `AbortSignal.timeout(4000)` per fetch, the lookup stage capped at 5 s. Skip non-HTML content types. HTMLRewriter handlers on `title` (concatenate chunks until `lastInTextNode`), `meta[property="og:title"]`, `meta[name="description"]`, `meta[property="og:description"]`, `head` end tag; read the stream manually and `reader.cancel()` after `</head>` or 256 KB. Pick `og:title` → `<title>` → description first 80 chars → fallback. Fallback: `@<user> on X` if the username was in the URL, else `X post <id>`; else last path segment de-slugged (hyphens and underscores to spaces, trailing hex or numeric token dropped, first letter capitalised) plus ` · <hostname>`; else hostname. Truncate titles at 2000 chars (L1 doc). Debug route in M1: `GET /debug/title?url=` behind the key, returns the chain's result and bytes read; remove or leave key-gated at M6.

**Claude request (D-8), from L2.** `new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 10_000 })`. `messages.create({ model: "claude-haiku-5-5", max_tokens: 512, output_config: { effort: "low", format: { type: "json_schema", schema } }, system, messages })`. Schema: object with `title` string and `tags` array, `minItems: 1`, `items.enum` = live option names, `required` both, `additionalProperties: false`. User message shapes: `X post by <author> (@handle): "<text>"\nURL: <url>`; `Title: <title>\nDescription: <description if any>\nURL: <url>`; `Title: (none)\nURL: <url>` plus `Description:` if any. No page body text: the HTMLRewriter stops at `</head>`. When the client sent a title, lookup is skipped and Claude gets the client title and URL only. System prompt verbatim from L2, with the allowed-tags line filled from the schema cache. Match returned tags to options case-insensitively, write the option id, cap 3.

**Contract (D-4).** `POST /save`, `content-type: application/json`, header `x-satchel-key`. Body `{ url: string, title?: string, status: "later" | "read" | "favorite" }`. Status map: later → Archived false, Favorite false; read → true, false; favorite → true, true. Every Worker response is JSON with `ok` (round 2). Responses: `200 {ok: true, id}`; `400 {ok: false, error: "invalid_body" | "invalid_url" | "url_too_long"}`; `401 {ok: false, error: "unauthorized"}`; `404 {ok: false, error: "not_found"}`; `405 {ok: false, error: "method_not_allowed"}`; `500 {ok: false, error: "internal"}` from a top-level catch; `502 {ok: false, error: "notion_<code>"}`. `OPTIONS /save` → 204 with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: content-type, x-satchel-key`, `Access-Control-Max-Age: 86400`. Every response carries `Access-Control-Allow-Origin: *`. `GET /health` without `x-satchel-key` → `200 {ok: true}` (liveness, no probes). With a wrong key → `401 {ok: false, error: "unauthorized"}`, same as `/save`. With the right key → `200 {ok: true, notion: "ok", claude: "ok", oembed: "ok"}` or `503` with the failing field set to `"auth_failed"`, `"not_found"`, `"error <status>"`.

**Extension (D-13).** Manifest: `manifest_version 3`, `action.default_popup`, `options_page`, `permissions: ["storage", "activeTab"]`, `commands._execute_action` with a suggested key the user can rebind. Manifest also declares a `background.service_worker`. Popup flow: read `chrome.storage.local` for URL and key; if missing, show "Set up Satchel" linking to options; `chrome.tabs.query({active: true, currentWindow: true})` for title and URL; render; L / R / F and clicks send `{url, title, status}` to the service worker and disable all three; the service worker POSTs and replies. Success only when the response is JSON with `ok: true`: show "Saved ✓" and `window.close()` after about 600 ms; otherwise "Couldn't save, try again" with the `error` value (or "unexpected response") small underneath. If the popup has closed, a failure sets `chrome.action.setBadgeText("!")` in red until the next successful save clears it. Options: two inputs, Save, a "Test" button that calls the keyed `/health` and shows each field in plain words ("Notion: ok", "Claude: key rejected", "X oEmbed: down"); 401 shows "Key rejected", a network error "Can't reach Worker".

**Shortcut (D-7), from L5.** Actions: Text (Worker URL, import question), Text (key, import question, default empty), Choose from Menu (Later / Read / ★ Favorite) each setting a `status` variable, Get Name of shortcut input, Get Contents of URL (`POST`, JSON body `url` = shortcut input as URL, `title` = name, `status`; header `x-satchel-key`; `Advanced` and `ShowHeaders` true), Get Dictionary Value `ok`, If is true → Show Notification "Saved ✓", Otherwise → Get Dictionary Value `error` → Show Notification "Satchel: not saved" with the value, or "unexpected response" when it's empty (round 2). Top-level: `WFWorkflowTypes ["ActionExtension"]`, input classes `WFURLContentItem`, `WFSafariWebPageContentItem`, `WFArticleContentItem`, `WFStringContentItem`. Agent-run structural assertion on the unsigned template (round 2): expected action identifiers in order, exactly one `x-satchel-key` header row, the key Text default empty, the `ok` branch present. Validity check: signed file begins `AEA1`; `shortcuts sign` ran from an agent session with network and no user step (L5 probe). First device test uses a wrong key on purpose.

</details>

<details>
<summary>Criteria and approaches compared</summary>

Weights from the criteria doc: 1 never lose a save (high), 2 fast banner (high), 3 agent-checkable (high), 4 fewest moving parts (medium), 5 forkable (medium), 6 month-three resilience (medium).

**Shape A (picked): thin sync write, everything else behind the response, stateless health.** One Worker. Response path is auth, canonicalize (no fetch), one dedupe query, one create or patch. `waitUntil` does title lookup when the client sent none, Claude, a re-read, one patch. Keyed `/health` live-probes Notion, Anthropic and oEmbed. Plain `fetch` for Notion, no `nodejs_compat`, no KV, hardcoded URL rules, generated and signed Shortcut.

**Shape B (strongest alternative): right on first paint, KV-backed health.** Same Worker, but title lookup (oEmbed or page fetch) runs before the create so the row never shows a fallback title. Claude alone runs in `waitUntil`. KV holds `claude_last_error` and `claude_last_ok`, shown on `/health`. Notion via the official SDK; `nodejs_compat` on for safety. This is the handoff read literally plus L2's and L4's recommendations.

**Shape C (sketched): thick clients, thin Worker.** The extension and Shortcut do title extraction client-side (the popup reads `og:title` from the page; the Shortcut uses Get Details of Safari Web Page) and the Worker only canonicalizes, dedupes and calls Claude.

| Criterion | A | B | C |
|---|---|---|---|
| 1 Never lose a save | Equal: both write before Claude | Equal | Equal |
| 2 Fast banner | Wins: Notion only, about 0.8 s | Loses: page fetch 0.2 to 1.9 s or a 403 wait, X oEmbed added; blocked sites push past 1.5 s | Wins for the popup; the Shortcut can't read `og:title` from X or Mail |
| 3 Agent-checkable | Wins: one boundary test | Harder: more on the response path to mock | Loses: client-side extraction isn't testable without a browser |
| 4 Fewest moving parts | Wins: no KV, no SDK, no flag | Loses: KV namespace, SDK dependency, flag | Middle: more client code, less Worker |
| 5 Forkable | Wins: deploy is secrets plus two vars | Loses: forker creates and binds a KV namespace | Loses: a Shortcut with extraction logic is harder to generate |
| 6 Month-three | Live probes answer "broken now?" | Wins slightly: history of failures | Equal |

B's one real advantage is history. For a tool used a few times a day, the untagged row plus 3 days of logs covers it. A's weakest point: a fallback title sits in Inbox for about two seconds, and stays if Claude is down. That's the price of the fast banner, and it's visible rather than silent.

</details>

<details>
<summary>Spike results</summary>

No spikes beyond the five research lanes. Their probe scripts and outputs live in the context directory and are cited by lane and rung throughout. Two unverified items became milestone checks instead of spikes: Cloudflare egress blocking (M1 debug route) and iOS 26 import questions (M4 device step).

</details>

<details>
<summary>Rejected candidates with the specific failure case</summary>

- `publish.twitter.com` as the oEmbed host: 301s to `publish.x.com` today, so it works by accident through redirect following at the cost of a subrequest and a future break (L3 probe).
- `@cloudflare/vitest-pool-workers`: deprecated on npm; `npm i` with Vitest 5 fails with ERESOLVE (L4 probe).
- `fetchMock` from `cloudflare:test`: `undefined` in the plugin (L4 probe).
- `maxItems` in the Claude schema: 400 `invalid_request_error` (L2 probe).
- `zodOutputFormat`: no handling for `maxItems`, so the same 400 (L2 repo).
- `x.com/i/web/status/<id>` passed to oEmbed: 404 HTML (L3 probe).
- Following all redirects: `youtu.be/ID` becomes a `?si=` URL and paywalls redirect to login (L3 probe).
- `contains host + path` for dedupe: `site.com/post` matches `site.com/post-2` (L1).
- Writing tags by name: a new name creates a schema option when the connection can write (L1 doc).
- Hand-built Shortcut exported from the app: the export is signed and encrypted, so a key inside it can't be seen (L5 probe).
- Chrome UA for page fetch: JS shell from Spotify, 403 from NYT, generic title from TikTok (L3 probe).
- Official X API v2: paid tier for any usable quota (L3 doc).
- KV for `/health` state: a binding every forker must create, 1 to 2 writes a save, for history the untagged row already provides (criterion 4).
- fxtwitter as an X fallback (round 1): a third party in M1 for a case the `X post <id>` fallback already covers; reopen if X posts land as `X post <id>` often.
- iTunes lookup for Apple Podcasts (round 1): an extra path when the HTML route serves `<title>` to any UA (L3 probe); reopen if the M1 debug route shows no `og:title`.
- A public probing `/health` (round 1): shares Notion's 180 a minute limit with saves and anyone could burn it; keyless liveness only.
- A Retry-After loop on the sync path (round 1): up to 60 s against a 5 s budget and the "Notion down fails visibly" call.
- Redirect-wrapper following on the response path (round 2): the only outbound fetch before the banner, and no scenario needs it; the popup, Safari and X all hand over final URLs (L3). Reopen: M5 Mail or X saves land as t.co, substack.com/redirect or beehiiv rows.
- Background Notion retry when Retry-After ≤ 2 s (round 2): contradicted "no retry" in sections 2 and 11; removed, `enrich_failed` instead.
- Popup owning the fetch (round 2): closing the popup mid-save drops it silently.
- "Saved ✓" whenever `error` is absent (round 2): a 404, 500, body-less 405 or Cloudflare HTML page reads as success.

</details>

<details>
<summary>Round logs</summary>

<details>
<summary>Round 1, 2026-11-07, median 7</summary>

**Round 1, 2026-11-07, median 7 (scores 7, 7, 7). Paraphrase gate passed first try.**

Seats: complexity skeptic (plan only), product reader (plan + handoff + user calls), premortem (plan only). Statistics and design-fidelity seats not run: no stats engine, no DESIGN.md yet (brand comes later). Lighter process per user.

**Verdicts (lead)**

[product] [blocking] D-10 Retry-After loop (60 s cap, 2 retries) runs on the sync path; contradicts "Notion down fails visibly" and the <5 s budget.
→ accepted: no Retry-After loop on the response path. Any Notion error or 429/529 on the sync query/create/patch returns 502 `notion_<code>` immediately. Background calls get at most one retry, only when Retry-After ≤ 2 s. Touches D-10, appendix "Response path budget", D-1 if it mentions retries.

[product] [should] D-7 rejects hand-building with "reopens never"; spec says "if signing fails, give me the manual build steps instead"; M4 has no failure path.
→ accepted: D-7 option (b) reopen line becomes "reopens if signing fails: manual build steps in the README." M4 done state names that failure path.

[product] [should] Brand step has no owner/handoff/done state; "name" listed though the product is named Satchel.
→ accepted: drop "name". Brand step owner = the lead running the brand-design skill (lightweight). Output handed to M3/M4: the mark as SVG, PNG icons 16/32/48/128, a Shortcut glyph and colour pick, and a handful of CSS custom properties (colours, type, radius). M3 is blocked until the brand step lands (it's short); M4 only needs the glyph/colour and can ship with a default if brand slips. No file names in the plan body.

[skeptic] [blocking] Title lookup's output is never written; M1 ships before Claude and its "how we'll know" says X save shows author and text; when Claude fails the oEmbed text is thrown away.
→ accepted, as one write: the background task ends in ONE patch. Name = Claude's title if Claude succeeded, else the looked-up raw title if lookup succeeded, else unchanged. Same "only if Name unchanged since create" guard. In M1 (no Claude yet) that patch writes the looked-up raw title. Data model table gets this rule.

[skeptic] [should] M1 is really an L; cut fxtwitter and the Apple Podcasts iTunes lookup.
→ accepted: drop fxtwitter (third party, X post <id> fallback covers it; keep it named as a reopen in D-3's record). Apple Podcasts goes through the HTML path like Overcast; the M1 debug route over the L3 URLs confirms og:title comes back; if not, iTunes lookup is the named reopen. M1 stays M.

[skeptic] [should] waitUntil budget overruns 30 s: SDK timeout is per attempt (20 s × 2), plus lookup 6 s, plus patch, plus D-10 retries.
→ accepted: lookup timeout 5 s; Claude timeout 8 s, maxRetries 1 (16 s worst); background Notion one retry only if Retry-After ≤ 2 s; an overall 25 s deadline (AbortSignal) on the background task that logs `enrich_deadline` before Cloudflare's 30 s cancel. Write the worst-case sum in the appendix (must be < 30 s).

[premortem] [blocking] Stored URL vs dedupe key undefined (appendix strips www./m. "for the dedupe key"; D-2/§6 just say canonical); host variants miss.
→ accepted: the stored URL is the canonical URL with the host lowercased, `m.`/`mobile.` dropped, and `www.` kept exactly as the (unwrapped) source had it. The dedupe query matches the path under both host forms (bare and `www.`), each with the existing equals / `?` / `#` / trailing-slash clauses, plus the raw URL; all within Notion's compound-filter limits (state the clause count). X stays on the post-id form. Add fixture rows: `m.nytimes.com/...` and `www.nytimes.com/...` and `nytimes.com/...` all dedupe to one row; stored form shown for each.

[premortem] [should] /health requires the key, so a browser tab or Safari can't open it; scenario 4's recovery path is a 401.
→ accepted in part: removing the gate is rejected, because a public /health that live-probes Notion shares the 180/min Notion limit with saves and anyone could burn it. Instead: `GET /health` without the key returns `{ok: true}` liveness only (no probes); with the key it runs the probes. The options page "Test" button shows the per-field result (notion / claude / oembed) in plain words. Scenario 4 goes through options → Test.

[premortem] [should] Work profile (the reason Satchel exists) first tested at M3; managed profile may block Load unpacked; corporate filter may block workers.dev.
→ accepted: M0 "User acts" adds: open the deployed /health URL in the work Chrome profile and confirm it loads, and confirm chrome://extensions shows the Developer mode toggle there. If either fails, stop and raise it before M1 (custom domain or packed extension become the reopen).

**Declined-to-judge items read**
- Workers Logs pricing change Dec 1, 2026 (product reader): already in D-17's context line; no change, it's two-way.
- Scenario 3 "Archived only" vs D-2 "Archived and Favorite" (skeptic): accepted as a wording fix: scenario 3 says Archived and Favorite follow the latest status.
- Everything else declined was a user call or taste, already in open questions.

Applied 2026-11-07. Changed records: D-1, D-2, D-3, D-4, D-7, D-8, D-9, D-10, D-17; data model; scenarios 3 and 4; risks 2, 4, 7; M0, M1, M2, M4, brand step; how we'll know M1, M2; Rules in full.

</details>

<details>
<summary>Round 2, 2026-11-07, median 7</summary>

**Round 2, 2026-11-07, median 7 (scores 7, 8, 7) plus scoped re-review (7 of 9 addressed). Final round (user capped the panel at two).**

**Verdicts (lead)**

[skeptic] [blocking] M2's done state uses the options-page Test button, which ships in M3.
→ accepted: M2 keeps keyed /health and its 503 test. "Options Test shows each field" moves to M3's done state and check.

[skeptic] [should] M4 is really M; its check needs the user and "plist lints" is undefined.
→ accepted in part: relabel M4 to M. Add an agent-run structural assertion on the unsigned template (expected action identifiers in order, the `x-satchel-key` header present, the key default empty, the `ok` branch present). Rejected: moving signing into User acts. Lane 5 ran `shortcuts sign` from an agent session on this Mac with network and no user step (L5 probe), so the AEA1 check stays agent-run.

[skeptic] [should] Cut redirect-wrapper following from M0; it's the only thing that breaks the 1.5 s banner and no scenario needs it.
→ accepted: wrapper following is cut from v1. Evidence: the popup sends the final tab URL; on iOS, tapping a Mail link opens Safari on the final URL (L3), and X shares x.com links. The canonicalizer still reads the target param out of google.com/url and l.facebook.com (no network). Reopen: M5 Mail or X saves land as t.co / substack.com/redirect / beehiiv rows. D-5 two-way. Response path is now one Notion query plus one write, no outbound fetch.

[product] [should] The spec's two "stop and tell me" setup cases have no milestone.
→ accepted: M0 User acts adds "if Notion returns 404 / object_not_found, stop and tell the user to add the Satchel connection via ••• → Connections." M2 User acts adds "if the Anthropic key is rejected (401), stop and tell the user to create a standard key at console.anthropic.com." (L2 already accepted the key; this covers revocation before M2.)

[product] [should] gitleaks pre-push hook has no milestone; first scan is M4.
→ accepted: M0 done state and check include the pre-push gitleaks hook (and a .gitignore covering local secrets files) before the first push.

[product] [note] D-1 changes the spec's "write the row with the raw title right away" (spec had title lookup on the sync path) and section 9 doesn't flag it.
→ accepted: list it in section 9 as a decision for the user review, with the plan's recommendation (fallback title first, real title about 2 s later) and the runner-up (lookup before the write, up to 5 s on the banner).

[re-review] waitUntil worst case isn't bounded: oEmbed calls lack timeouts, X does two fetches in a row, SDK backoff and 429 handling not in the sum, re-read/patch have no timeout, deadline behaviour undefined.
→ accepted: every background fetch gets its own timeout (each lookup fetch 4 s, the whole lookup stage capped at 5 s; schema retrieve 3 s; re-read 3 s; patch 3 s). Claude: one attempt, `maxRetries: 0`, `timeout: 10_000`. Background Notion calls never retry (see contradiction below). Stage deadline at 22 s: if Claude hasn't returned, abandon it and write the looked-up title (if any) in the final patch. Write the bounded worst case in the appendix: 5 + 3 + 10 + 3 + 3 = 24 s, under 30.

[re-review] /health with a present but wrong key is unspecified.
→ accepted: a wrong key on /health returns 401 `{ok:false, error:"unauthorized"}`, same as /save. Options Test shows "Key rejected" for 401, "Can't reach Worker" for network errors, and per-field words otherwise.

[re-review] contradiction: section 2 and section 11 say "no retry" but D-10 added a background retry when Retry-After ≤ 2 s.
→ accepted, by removal: background Notion calls don't retry either. A failed background patch logs `enrich_failed` and leaves the row as saved. One rule everywhere: Satchel never retries Notion.

[premortem] [blocking] The Shortcut shows "Saved ✓" whenever `error` is absent, so a 404, a 500, a body-less 405, or a Cloudflare HTML error reads as success.
→ accepted: success is shown only when the response is JSON with `ok: true`. Anything else shows "Satchel: not saved" plus the `error` value, or "unexpected response" if there isn't one. The contract adds: every Worker response is JSON with `ok`, including 404 `not_found`, 405 `method_not_allowed`, and 500 `internal` from a top-level catch. Same rule in the popup.

[premortem] [should] Closing the popup mid-save can drop the save silently.
→ accepted: the popup hands the save to the extension's background service worker, which makes the request, so closing the popup doesn't cancel it. If the popup is still open it shows the result. If the save fails after the popup closed, the service worker sets a red "!" badge on the toolbar icon until the next successful save. On the Worker side, the Notion write runs to completion even if the client disconnects (pass the save promise to waitUntil as well). M3 check: save, close the popup at once, row lands; wrong key with popup closed shows the badge.

[premortem] [should] Fallbacks hide quality drift; slug titles and "X post <id>" rows look normal.
→ accepted in part: no new probe (prefer removing over adding). Section 8 names the gap as an accepted risk. Signal: the morning Inbox shows slug or "X post <id>" titles, or the M5 pass finds one. Reopen: add a title-lookup probe on one known URL to keyed /health.

**Declined-to-judge items read**
- minItems: 1 masking failures (premortem): left as is; tags-on-everything is the product goal.
- Nothing else new.

Applied 2026-11-07. Changed records: D-1, D-4, D-5, D-7, D-8, D-9, D-10, D-13, D-14, D-17; components; section 4 flow; risks 4, 8; section 9 (D-1 for user review); M0, M2, M3, M4; left out; Rules in full (budget, canonicalization, title lookup, Claude request, contract, extension, Shortcut); Shape A; rejected candidates.

</details>

<details>
<summary>User review</summary>

2026-11-07. The user read the risks, milestones and sequencing ("looks good").

- D-1 title-first: approved (fallback title first, real title about 2 s later).
- Title casing: Title Case (the draft said sentence case; changed in the Claude rules).
- YouTube `t=`: strip.
- Anthropic key: keep the verified `sk-ant-usr-` key; the "check Expires" user act is removed from M2.
- Media host list (D-16): kept as drafted (YouTube, Vimeo, Spotify, Apple Podcasts, Overcast, Pocket Casts, SoundCloud, Twitch, TikTok; Instagram off); user asked what it meant, open to a veto.
- Noted without objection: newsletter wrapper following cut; Notion never retried.

</details>

</details>

<details>
<summary>Epic snapshot</summary>

Filed after the user's review.

</details>

<details>
<summary>Epic snapshot: what we thought the epic would be (2026-11-07)</summary>

Filed to Linear, team Satchel, project V1 Satchel Buildout. Linear is live; this snapshot isn't kept in sync.

- **M0: Walking Skeleton.** SAT-1 Scaffold Worker repo, harness and guardrails · SAT-2 Canonicalize URLs with strip table and fixtures · SAT-3 Notion client with no retry · SAT-4 Router, auth, CORS and JSON error contract · SAT-5 Fallback title · SAT-6 Save handler: dedupe, create or patch, boundary · SAT-7 Gate: deploy, secrets, real curl, work-profile check
- **M1: Title Lookup.** SAT-8 X title via oEmbed with Twitterbot fallback · SAT-9 Media titles via oEmbed · SAT-10 Page titles via HTMLRewriter with a crawler UA · SAT-11 Key-gated debug title route · SAT-12 Enrich stage 1: lookup orchestration and the one final patch
- **M2: Claude Enrich and Health.** SAT-13 Schema cache and tag guard · SAT-14 Claude client with structured outputs · SAT-15 Enrich stage 2: Claude, tag guard, 22 s deadline · SAT-16 Keyed /health probes · SAT-17 Gate: real enriched save, key check
- **M3: Chrome Extension.** SAT-18 Brand: mark, icons and tokens · SAT-19 Manifest and service worker owning the save · SAT-20 Popup: title, Later / Read / ★, keys L / R / F · SAT-21 Options page with Test · SAT-22 Gate: load unpacked in both profiles
- **M4: iOS Shortcut.** SAT-23 Shortcut generator · SAT-24 Template structural assertion · SAT-25 Sign step and install docs · SAT-26 Gate: AirDrop and first phone save
- **M5: Device Test Pass.** SAT-27 Device and profile test pass
- **M6: Open-Source Readiness.** SAT-28 Public README · SAT-29 License and CI · SAT-30 Gate: full-history scan and flip public

Seam read before filing: 7 findings (4 blocking), all accepted; verdicts applied to the briefs.

</details>
