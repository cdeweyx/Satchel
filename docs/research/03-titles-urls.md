# Lane 3: canonical URLs and raw titles

Date: 2026-11-07. Probes in `.context/probes/titles/` (outputs saved as `*.out` next to each script). All probes ran from a laptop in the US, not Cloudflare egress; see "What may differ on Workers."

## 1. Answer

- **Canonicalize in code with a small hardcoded list, no dependency.** ClearURLs' global list is ~50 regexes and the per-site lists we care about (X, YouTube, Spotify, Medium) are 1 to 5 params each. Copy them into one `tracking-params.ts`, cite ClearURLs as the source, done. The ClearURLs `data.min.json` is 106 KB and 206 providers; pulling it in buys nothing for a personal tool.
- **X posts: reduce every form to `https://x.com/i/status/<id>` as the dedupe key, then let oEmbed hand back the canonical `x.com/<user>/status/<id>` for the stored URL.** Verified: oEmbed accepts `i/status/<id>` and any username (wrong ones are silently corrected), strips `?s=46&t=…`, and rejects `i/web/status/<id>` with a 404 HTML page. So rewrite `i/web/status` to `i/status` before calling.
- **Call `https://publish.x.com/oembed`, not `publish.twitter.com`.** The old host now 301s to the new one (verified 2026-11-07). No auth, documented as not rate limited, returns `author_name` plus post text inside `html`. Errors come back as 404 HTML (deleted/missing post) or 400 JSON (bad params), so check `content-type` before `JSON.parse`.
- **Page titles: fetch with a link-preview crawler User-Agent, parse with HTMLRewriter, cap the read.** A `facebookexternalhit/1.1`-style UA got real `og:title` from Spotify, TikTok and NYT where a Chrome UA got a JS shell or a 403. Medium (Cloudflare challenge), Bloomberg, The Atlantic and WSJ block every UA; those fall back to the client-passed title or the hostname.
- **Media sites: use their public oEmbed endpoints for the title, not the HTML.** YouTube pages are 1.3 to 1.5 MB; YouTube oEmbed is ~100 ms and a few hundred bytes. Spotify, Vimeo, TikTok and SoundCloud also have public oEmbed. Apple Podcasts has the iTunes Lookup API (130 ms JSON).
- **Newsletter links: follow redirects only for known wrapper hosts, then strip params.** A real Substack email link 302'd to `https://geni.us/…?utm_source=substack&utm_medium=email` (a second wrapper, with tracking params appended). Following everything is wrong: `youtu.be/ID` follows to `youtube.com/watch?si=…&v=ID&feature=youtu.be`, and paywalled sites redirect to login pages.

## 2. Verified table

| Claim | Rung | Result | Source | Decision it feeds |
|---|---|---|---|---|
| `publish.twitter.com/oembed` 301s to `publish.x.com/oembed` | probe | 301, `location: https://publish.x.com/oembed?...` | `oembed.sh`, run 2026-11-07 | oEmbed host |
| oEmbed accepts `x.com/i/status/<id>` and returns canonical `url` with real username | probe | 200 JSON, `url: https://x.com/elonmusk/status/…` | `oembed.out` | X canonical URL |
| oEmbed ignores username in path (wrong user still resolves) | probe | `x.com/wrongusername/status/1002103360646823936` → Naval's post | `oembed.out` | X normalizer can drop username |
| oEmbed rejects `x.com/i/web/status/<id>` | probe | 404, `text/html` "Nothing to see here" page | `oembed.out` | Rewrite `i/web/status` → `i/status` |
| oEmbed strips `?s=46&t=…` from returned `url` | probe | `url` has no query | `oembed.out` | Don't need to pre-strip for oEmbed, but do for dedupe key |
| Missing/deleted post returns 404 HTML, not JSON | probe | 404 `text/html` | `oembed.out` | Check content-type before parse |
| Missing `url` param returns 400 JSON `{"errors":[{"code":357,...}]}` | probe | 400 `application/json` | `oembed.sh` output | Error shape |
| Profile URL (`x.com/naval`) returns 200 with `title: ""` and a timeline embed | probe | 200 JSON, no post text | `oembed.sh` output | Only call oEmbed for `/status/` URLs |
| oEmbed `html` contains post text in `<p>` and `t.co` links as `<a>` | probe | OpenAI post: text + `https://t.co/sHDm57g3Kr` | `oembed.sh` output | Title extraction regex |
| `t.co/<id>` resolves with a plain 301 `Location` on HEAD | probe | 301 → `https://openai.com/blog/chatgpt/` | Bash probe 2026-11-07 | Wrapper list includes `t.co` |
| oEmbed docs: no auth, "not rate limited", `cache_age` 3153600000, endpoint `publish.x.com` | doc | confirmed | https://docs.x.com/x-for-websites/oembed-api.md (fetched 2026-11-07) | Month-three risk |
| oEmbed docs carry no deprecation notice; markup "may change over time" | doc | confirmed | same | Month-three risk |
| x.com serves `og:title`/`og:description` to `Twitterbot/1.0` UA | probe | 200, 51 KB, `og:title: Naval (@naval) on X`, `og:description: <post text>` | Bash probe 2026-11-07 | oEmbed fallback #1 |
| `api.fxtwitter.com/status/<id>` returns author + text JSON | probe | 200, code 200, `Naval \| How to Get Rich…` | Bash probe 2026-11-07 | oEmbed fallback #2 (third party) |
| ClearURLs rules: 206 providers, global list of ~50 regexes, X rules `(?:ref_?)?src, s, cn, ref_url, t`, YouTube `feature, gclid, kw, si, pp`, Spotify `si`, Medium `source` | repo | confirmed; last commit 2026-11-03 | https://raw.githubusercontent.com/ClearURLs/Rules/master/data.min.json (fetched 2026-11-07), saved as `clearurls.json` | Strip list |
| Substack email link is `substack.com/redirect/<uuid>?j=<jwt>` and 302s to target with `utm_source=substack&utm_medium=email` appended | probe | 302 → `https://geni.us/…?utm_source=substack&utm_medium=email` | Bash probe on a real newsletter link from the user's Gmail, 2026-11-07 | Follow wrappers, then strip |
| Substack plain-text email "View this post on the web" link is direct (no wrapper) | probe | `https://themagnet.substack.com/p/…` | same email | Wrapper handling only matters for in-body links |
| Chrome UA gets JS shell from Spotify (`title: Spotify – Web Player`, no og); crawler UA gets real `og:title` | probe | 169 KB vs 187 KB, 0.3 to 0.6 s | `titles2.out` | Fetch UA |
| NYT: Chrome UA → 403 (771 B); crawler UA → page served (my URL was a 404 but the site rendered) | probe | 403 vs 404+93 KB | `titles.out`, `titles2.out` | Fetch UA |
| TikTok: Chrome UA → generic title; crawler UA → `TikTok · Scout, Suki & Stella` | probe | 403 KB vs 6.7 KB | `titles2.out` | Fetch UA |
| Medium → Cloudflare challenge "Just a moment..." for curl, Chrome, facebookexternalhit, Twitterbot | probe | 403 all four | `titles.out`, `titles2.out`, Bash | Fallback title |
| Bloomberg ("Are you a robot?"), The Atlantic ("Your access has been blocked"), WSJ (401/403) block all UAs | probe | 403/401 | `titles.out` | Fallback title |
| GitHub, Substack post, Stratechery, paulgraham.com, a16z, Apple Podcasts serve `<title>` (and usually `og:title`) to any UA | probe | 200, 80 KB to 640 KB, 0.2 to 1.9 s | `titles.out`, `titles2.out` | HTML path is the default |
| YouTube watch page is 1.35 to 1.5 MB | probe | 200, ~1.4 MB, 0.4 to 1.4 s | `titles2.out` | Use oEmbed for YouTube |
| YouTube oEmbed works for `youtu.be/<id>` and `/shorts/<id>` | probe | 200 JSON, `title`, `author_name`, ~0.1 s | `media-oembed.out` | Media title path |
| Spotify oEmbed (`open.spotify.com/oembed?url=`) returns `title` | probe | 200, `title: My Path to Spotify: Women in Engineering` | Bash probe 2026-11-07 | Media title path |
| Vimeo oEmbed (`vimeo.com/api/oembed.json?url=`) returns `title`, `author_name`; 404 for a nonexistent video | probe | 200 for 76979871, 404 for 148751763 | Bash probe, `media-oembed.out` | Media title path |
| TikTok oEmbed and SoundCloud oEmbed return JSON with `title` | probe | 200 | `media-oembed.out` | Media title path |
| iTunes Lookup `itunes.apple.com/lookup?id=<id>` returns `collectionName`; `&entity=podcastEpisode` returns episode `trackName` | probe | 200, 0.13 s | Bash probe 2026-11-07 | Apple Podcasts title |
| arXiv PDF: `application/pdf`, 2.2 MB, no HTML | probe | 200 | `titles.out` | Skip non-HTML bodies |
| Workers `fetch` default `redirect: "follow"`; `"error"` throws TypeError; `AbortSignal` supported | doc | confirmed | https://developers.cloudflare.com/workers/runtime-apis/request/ (fetched 2026-11-07) | Wrapper following, read cap |
| Free plan: 50 subrequests per request, 10 ms CPU, `waitUntil` up to 30 s after response; each hop in a redirect chain counts as a subrequest; 6 concurrent open connections | doc | confirmed | https://developers.cloudflare.com/workers/platform/limits/ (fetched 2026-11-07) | Where title fetch runs |
| HTMLRewriter streams, `text` chunks need concatenation with `lastInTextNode`, selectors like `meta[property="og:title"]` work, no documented early-abort | doc | confirmed | https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/ (fetched 2026-11-07) | Parser choice |
| Proposed canonicalizer passes 20 fixtures | probe | see table in section 6 | `normalize.mjs`, `normalize.out` | Test fixtures |

## 3. Recommendations per decision

**Strip list: hardcoded, sourced from ClearURLs (one-way, trivially reversible).**
Global exact: `fbclid gclid dclid gbraid wbraid msclkid twclid ttclid yclid igshid igsh mc_cid mc_eid mc_tc mkt_tok _hsenc _hsmi __hsfp __hssc __hstc hsCtaTracking vero_id vero_conv oly_anon_id oly_enc_id _ga _gl srsltid cmpid ncid ref_src ref_url __twitter_impression wickedid rb_clickid ml_subscriber ml_subscriber_hash s_cid triedRedirect isFreemail`. Global prefix: `utm_ mtm_ pk_ ga_ itm_ otm_ hsa_`. Per host: x.com `s t cn src ref`; youtube.com/youtu.be `si feature pp kw app ab_channel`; spotify.com `si nd dlsi context pi`; medium.com `source sk gi`; substack.com `r s publication_id post_id showWelcomeOnShare`; podcasts.apple.com `l uo at ct itscg itsct ls`; nytimes.com `smid referringSource` (keep `unlocked_article_code`, it's a gift link); tiktok.com `_r _t is_from_webapp sender_device web_id`; reddit.com `share_id rdt`. Runner-up: depend on ClearURLs JSON at build time. Rejected: 106 KB for ~15 params that matter to this reading list, plus a regex engine to run them.

**X normalization: dedupe on `https://x.com/i/status/<id>`, store oEmbed's canonical `url` (one-way).**
Accept hosts `twitter.com`, `mobile.twitter.com`, `x.com`, `fxtwitter.com`, `vxtwitter.com`, `fixupx.com`. Match path `/(?:i\/web\/status|i\/status|[A-Za-z0-9_]{1,15}\/status(?:es)?)\/(\d+)` and drop anything after the id (`/photo/1`, `/video/1`). Store `oembed.url` when the call succeeds (it has the username, which reads better in Notion), else store `x.com/i/status/<id>`. Dedupe must compare on the id form, since the same post could arrive under either. Runner-up: store `i/status` always. Simpler, uglier in the URL column.

**oEmbed call (one-way): `GET https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2Fi%2Fstatus%2F<id>&omit_script=true&dnt=true`.**
Parse: `author_name`, then text = inner text of the first `<p …>…</p>` in `html`, HTML-entity-decoded, with `<a href="https://t.co/…">` kept as its text (that's the link the author posted). Raw title = `${author_name}: ${text}`; Claude shortens it later. Treat non-JSON content-type or `errors[]` as "no title" and fall back (next item). The docs say the call isn't rate limited and `cache_age` is 100 years, so cache nothing.

**oEmbed fallback chain (two-way; order can change).** 1) fetch `https://x.com/<anything>/status/<id>` with UA `Twitterbot/1.0` and read `og:description` (post text) + `og:title` ("Naval (@naval) on X"). Verified working today; X could gate it any time. 2) `https://api.fxtwitter.com/status/<id>` (third party, no auth, returns `tweet.author.name`, `tweet.text`). 3) hostname fallback below. Rejected: the official X API v2 (`GET /2/tweets/:id`) needs a paid tier for any meaningful quota.

**Page title fetch (one-way on UA and parser; two-way on the read cap number).**
- UA: `Mozilla/5.0 (compatible; Satchel/0.1; +https://github.com/cdeweyx/Satchel) facebookexternalhit/1.1`. Add `Accept: text/html,*/*;q=0.8` and `Accept-Language: en-US,en;q=0.9`. Runner-up: a Chrome UA. Loses on Spotify, TikTok, NYT in the probes.
- Parser: HTMLRewriter with handlers on `title` (concatenate `text` chunks until `lastInTextNode`), `meta[property="og:title"]`, `meta[name="description"]`, `meta[property="og:description"]`. Drive it by reading the transformed body; stop by reading the stream manually and calling `reader.cancel()` once `og:title` and `</head>` (handler on `head` with `onEndTag`) are seen, or once 256 KB has passed. HTMLRewriter has no documented early-abort, so the cancel is ours.
- Pick order: `og:title` → `<title>` → `og:description`/`description` (first 80 chars) → hostname.
- Skip the body if `content-type` isn't `text/html` (the arXiv PDF case): use the filename or hostname.
- Timeout: `AbortSignal.timeout(6000)`. Run this in `waitUntil` alongside Claude when the client sent no title, so the save returns in one Notion write; if the client sent a title, don't fetch at all.

**Media title path (one-way): known media hosts skip HTML and call oEmbed.**
YouTube `https://www.youtube.com/oembed?format=json&url=`; Spotify `https://open.spotify.com/oembed?url=`; Vimeo `https://vimeo.com/api/oembed.json?url=`; TikTok `https://www.tiktok.com/oembed?url=`; SoundCloud `https://soundcloud.com/oembed?format=json&url=`; Apple Podcasts `https://itunes.apple.com/lookup?id=<show id>` (and `&entity=podcastEpisode` then match `trackId` to the `?i=` param). Each returns `title` (`collectionName`/`trackName` for Apple). Overcast and Pocket Casts: fetch HTML like any page (their share pages are small). Runner-up: HTML for everything. Loses 1.4 MB per YouTube save on a 10 ms CPU budget.

**Media checkbox domain list (two-way).** `youtube.com youtu.be music.youtube.com vimeo.com open.spotify.com spotify.link podcasts.apple.com music.apple.com overcast.fm pca.st pocketcasts.com soundcloud.com twitch.tv tiktok.com`. Exclude: `x.com` (posts aren't media even with video), `instagram.com` (reels are media but most saves there would be posts; revisit). TikTok in: the user said "YouTube, Vimeo, Spotify, Apple Podcasts and similar"; TikTok is video-first like YouTube Shorts. Match on hostname after `www.`/`m.` strip, exact or suffix.

**Redirect wrappers (one-way): follow only for a wrapper list, with `redirect: "follow"`, then canonicalize `response.url`.**
List: `t.co substack.com/redirect/* email.*.substack.com/c/* *.list-manage.com/track/click link.mail.beehiiv.com/ss/c/* links.*.beehiiv.com click.convertkit-mail*.com *.convertkit-mail.com url*.mailchimp.com lnkd.in bit.ly buff.ly l.facebook.com/l.php (read `u` param instead) google.com/url (read `q`/`url` param instead) out.reddit.com (read `url`)`. For everything else keep the client's URL. Chains happen (Substack → geni.us → Amazon): cap at 5 hops via the redirect-chain subrequest count, and canonicalize the final URL (the Substack hop appended `utm_source=substack&utm_medium=email`). From iOS Mail, tapping a link opens Safari on the final URL, so the share sheet already hands over the resolved page; the wrapper only arrives if the user long-presses "Copy Link" in Mail. Runner-up: follow all redirects. Rejected for the `youtu.be` and paywall-login reasons above.

**Fallback title when fetch fails or is blocked (one-way).** Priority: 1) title the client passed; 2) for X, `@<username> on X` if the username was in the URL, else `X post <id>`; 3) last path segment de-slugged (`thinking-about-code-review-cfd6e3b6cc7d` → "Thinking about code review", dropping a trailing hex/id token) plus ` · <hostname>`; 4) bare hostname. Never store an empty Name: Notion renders "Untitled" and the Inbox view becomes unreadable. Claude still runs on the fallback title and the URL, which recovers Medium titles most of the time since the slug is the title.

## 4. Gotchas for the build agent

- `publish.x.com` is the host. `publish.twitter.com` still 301s there, so code pointing at the old host works by accident through `redirect: "follow"`, at the cost of a wasted subrequest and a future break.
- oEmbed error bodies are HTML with status 404 for missing posts; `response.ok` false plus `content-type: text/html`. Bad params give 400 JSON `{"errors":[{"code":357,"message":"url: queryParam is required"}]}`. Check `content-type` includes `application/json` before `JSON.parse`.
- oEmbed `html` escapes `<` as `<` in the JSON; after `JSON.parse` it's normal HTML. Post text is inside `<p lang="…" dir="…">…</p>`; `<br>` separates lines; entities like `&amp;` `&#39;` need decoding. Links appear as `<a href="https://t.co/…">https://t.co/…</a>`.
- `cache_age` is the string `"3153600000"`; `height` is `null` for posts.
- Protected or suspended accounts weren't probed (no stable example). Expect 404 HTML or a 403; treat any non-JSON as fallback.
- HTMLRewriter `text` chunks: `<title>` can arrive in several chunks; concatenate and finish on `lastInTextNode`. A handler throwing truncates the stream; use a flag plus `reader.cancel()`, not a throw, to stop early.
- Free plan CPU is 10 ms per request. HTMLRewriter is native and cheap, but entity decoding a 1.4 MB YouTube page in JS isn't; hence the oEmbed path and the 256 KB cap.
- Each redirect hop is a subrequest (free plan: 50 per request). Substack → geni.us → Amazon is 3 hops plus the Notion writes, fine. Don't follow wrappers inside a loop over many URLs.
- The X share sheet on iOS appends `?s=<n>&t=<token>` (one 2024 report saw `s=12`, desktop "Copy link" gives `s=46` in common examples); the `s` value varies by platform, so strip `s` and `t` on x.com regardless of value. `i/web/status/<id>` comes from X's own notification emails and some in-app shares; `i/status/<id>` from the app's "Copy link" on some versions. Not verified from a device in this lane (no device probe); the normalizer treats all three identically so it doesn't matter.
- Substack params: `r=<reader id>` and `s=r` are tracking. Strip them only on `*.substack.com` hosts or when `utm_source=substack` is present, since custom-domain newsletters (lennysnewsletter.com) can't be detected by host, and `s`/`r` are too generic to strip globally.
- WHATWG `URL` lowercases the host for you but not the path. Don't lowercase paths (Medium slugs and GitHub are case-sensitive). Do drop the fragment, drop a trailing `/` on non-root paths, upgrade `http:` to `https:`, and drop a trailing `?`.
- Vimeo HTML with a non-browser UA was an 8 KB shell with no `<title>` for one video and a full page for another; oEmbed was consistent. Vimeo oEmbed 404s for a missing video.
- x.com HTML to `Twitterbot/1.0` gives `og:title: "Naval (@naval) on X"` and `og:description: <post text>`. The author's display name is in `og:title` before ` (@`.

## 5. Still unverified

| Item | Rung now | Rung needed | How |
|---|---|---|---|
| Exact link shape the X iOS app share sheet emits today (`s=` value, `i/status` vs username path) | doc (2024 blog reports) | device probe | Share one post from the X app to the Shortcut or Notes on the user's phone; record the URL. One minute during the step-5 test pass. |
| Mailchimp (`list-manage.com/track/click`) and beehiiv (`link.mail.beehiiv.com/ss/c/`) redirect behavior with a real token | structural (bogus tokens gave 200 and 403) | probe | Pull one real link each from Gmail and HEAD it, same as the Substack probe. |
| Whether Cloudflare egress IPs get the same responses as a laptop (NYT, Spotify, TikTok served to the crawler UA; Medium blocked) | laptop probe | Workers probe | Deploy a `/debug/title?url=` route behind the key during build step 1 and re-run `titles2.sh` URLs through it. Bot-management vendors score Cloudflare ASN differently; expect more 403s, not fewer. |
| oEmbed behavior for protected/suspended accounts and age-gated posts | none | probe | Needs a known protected post id; skip unless a save fails in month one. |
| HTMLRewriter early cancel via `reader.cancel()` releasing the subrequest promptly | doc (no statement) | Workers probe | Same `/debug/title` route; log bytes read on a YouTube page. |
| `publish.x.com` longevity | doc (no deprecation notice, 2026-11-07) | none available | Build the fallback chain; add a `/health` sub-check that calls oEmbed on `x.com/jack/status/20` so a break is visible. |

## 6. URL test fixtures

Verified by running `normalize.mjs` (output in `normalize.out`). "Canonical" is the dedupe key; for X, the stored URL may be the oEmbed `url` with the username.

| Input | Expected canonical | Kind |
|---|---|---|
| `https://x.com/naval/status/1002103360646823936?s=46&t=abcDEF` | `https://x.com/i/status/1002103360646823936` | x |
| `https://twitter.com/naval/status/1002103360646823936` | `https://x.com/i/status/1002103360646823936` | x |
| `https://mobile.twitter.com/naval/status/1002103360646823936` | `https://x.com/i/status/1002103360646823936` | x |
| `https://x.com/i/status/1002103360646823936` | `https://x.com/i/status/1002103360646823936` | x |
| `https://x.com/i/web/status/1002103360646823936` | `https://x.com/i/status/1002103360646823936` | x |
| `https://x.com/naval/status/1002103360646823936/photo/1` | `https://x.com/i/status/1002103360646823936` | x |
| `https://x.com/naval` | `https://x.com/naval` | page (no oEmbed) |
| `https://youtu.be/dQw4w9WgXcQ?si=abc123` | `https://youtube.com/watch?v=dQw4w9WgXcQ` | media |
| `https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be&t=42s` | `https://youtube.com/watch?v=dQw4w9WgXcQ` | media (drops `t=`; two-way, keep it if timestamps matter) |
| `https://www.youtube.com/shorts/aqz-KE-bpKQ` | `https://youtube.com/watch?v=aqz-KE-bpKQ` | media |
| `https://m.youtube.com/watch?v=dQw4w9WgXcQ` | `https://youtube.com/watch?v=dQw4w9WgXcQ` | media |
| `https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5?si=XYZ` | `https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5` | media |
| `https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29?utm_source=substack&utm_medium=email&r=abc&s=r` | `https://lennysnewsletter.com/p/what-is-good-retention-issue-29` | page (`r`/`s` stripped because `utm_source=substack`) |
| `https://medium.com/@kentbeck_7670/thinking-about-code-review-cfd6e3b6cc7d?source=rss----abc` | `https://medium.com/@kentbeck_7670/thinking-about-code-review-cfd6e3b6cc7d` | page |
| `https://www.nytimes.com/2025/01/27/technology/deepseek.html?smid=nytcore-ios-share&referringSource=articleShare&unlocked_article_code=1.abc` | `https://nytimes.com/2025/01/27/technology/deepseek.html?unlocked_article_code=1.abc` | page (the prototype kept `smid`; add it to the nytimes list) |
| `http://example.com/a/?fbclid=IwAR123&gclid=x&mc_cid=1&mc_eid=2#section` | `https://example.com/a` | page |
| `https://example.com/path?page=2&utm_campaign=x&ID=7` | `https://example.com/path?page=2&ID=7` | page (non-tracking params and their case preserved) |
| `https://podcasts.apple.com/us/podcast/lennys-podcast/id1627920305?i=1000600000000&l=en-US` | `https://podcasts.apple.com/us/podcast/lennys-podcast/id1627920305?i=1000600000000` | media |
| `https://github.com/cloudflare/workers-sdk/` | `https://github.com/cloudflare/workers-sdk` | page |
| `https://EXAMPLE.com/Path/To?b=1` | `https://example.com/Path/To?b=1` | page |
| `https://t.co/sHDm57g3Kr` | `https://openai.com/blog/chatgpt` | wrapper → follow → canonicalize |
| `https://substack.com/redirect/aee2338d-…?j=…` | final URL after chain, params stripped (today: `https://geni.us/VEyiAXB`) | wrapper → follow → canonicalize |

## Dead ends

- `developer.x.com/en/docs/x-for-websites/oembed-api` returns 402 to fetchers; use `docs.x.com/x-for-websites/oembed-api.md`.
- `core.trac.wordpress.org/ticket/59142` (the publish.x.com migration thread) 403s to fetchers; the search snippet was enough: publish.x.com redirected to publish.twitter.com in mid-2024, and the direction flipped later.
- Guessed URLs for Lenny's, NYT, Spotify, Overcast and The Verge 404'd on the first pass; `titles2.sh` holds real ones. Don't reuse `titles.sh` URLs.
- Vimeo 148751763 doesn't exist (both HTML and oEmbed fail); use 76979871.

## What this means for the step that asked

The Worker's URL and title layer is ~150 lines with no dependencies: a canonicalizer (section 6 fixtures as its test file), a 15-entry strip table, a 15-host media list, a 12-host wrapper list, one oEmbed call for X with a two-step fallback, one oEmbed/lookup call per media host, and an HTMLRewriter fetch with a crawler UA and a 256 KB cap for everything else. The only real month-three risk is X's oEmbed; the fallback chain (x.com `og:description` to Twitterbot, then fxtwitter) is verified today and costs nothing until it's needed. Add the `/health` oEmbed sub-check so a break shows up before the Inbox fills with `X post 1234…` titles.
