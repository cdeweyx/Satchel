# Lane 4: Cloudflare Worker, free plan fit and local test loop

Date: 2026-11-07. Probe project: `.context/probes/cloudflare/` (gitignored, npm-installed, 4 passing tests). No `wrangler login`, no deploy.

## Answer

- **Free plan is safe.** The per-request CPU cap is 10 ms; a save's actual CPU is well under 1 ms of work (JSON parse plus URL cleanup is microseconds, HTMLRewriter over a 258 KB page is about 1 ms, Anthropic client construction about 1 to 2 ms). Time awaiting Notion, the page fetch, and Claude doesn't count. The 100,000 requests/day and 50 subrequests/request limits are two orders of magnitude above a personal save tool (a save uses 4 to 6 subrequests).
- **`ctx.waitUntil` gives 30 s after the response, shared across all calls, and pending promises are canceled at the cap.** The Claude patch needs the SDK configured with `timeout` and `maxRetries` so it finishes inside that window. CPU inside `waitUntil` counts toward the same 10 ms, which is still fine.
- **The test tooling changed in October 2026.** `@cloudflare/vitest-pool-workers` is deprecated on npm; the replacement is `@cloudflare/vitest-plugin` (1.6.0) on Vitest 4.1+ or 5.x. `fetchMock` is gone from `cloudflare:test`; outbound mocking is now `msw@3` plus `@msw/cloudflare`. The probe runs this stack: install 5 s, full test run about 3.7 s, `wrangler dev` ready in 2 s.
- **`waitUntil` work is assertable** with `createExecutionContext()` plus `waitOnExecutionContext(ctx)` from `cloudflare:test`. The probe asserts the Notion PATCH hasn't happened before the response and has after the flush.
- **Secrets:** `wrangler secret bulk ~/.config/satchel/secrets.env` accepts a `.env` file directly, nothing echoed. Locally `.dev.vars` (dotenv syntax) is picked up by both `wrangler dev` and vitest, and `wrangler types` folds its keys into `Env`. `wrangler.jsonc` is Cloudflare's recommended config format.
- **CORS:** the Worker should answer preflight (`OPTIONS` returning `Access-Control-Allow-Origin: *` and `Allow-Headers: content-type, x-satchel-key`). This works from both Chrome profiles with no `host_permissions` and also covers iOS Shortcuts and curl. Keep the extension manifest permission-free for the Worker URL.

## Verified table

| Claim | Rung | Result | Source | Decision it feeds |
|---|---|---|---|---|
| Free: 100,000 req/day, 10 ms CPU/request, 50 subrequests/request, 64 MiB bundle, 100 Workers, 6 simultaneous outbound connections | doc | confirmed | developers.cloudflare.com/workers/platform/limits/ (Oct 29, 2026) | Plan choice |
| Paid ($5): 10M req/month then $0.30/M, 30M CPU-ms/month then $0.02/M, 30 s default CPU cap (up to 5 min), 10,000 subrequests | doc | confirmed | developers.cloudflare.com/workers/platform/pricing/ (Oct 2, 2026) | Upgrade trigger |
| Awaiting `fetch()` / network does not count toward CPU time; wall time has no hard limit for HTTP Workers | doc | confirmed | limits page (Oct 29, 2026) | CPU estimate |
| CPU overrun returns Error 1102 "Worker exceeded resource limits", outcome `exceededCpu` | doc | confirmed | limits page (Oct 29, 2026) | Upgrade signal |
| Over 100k/day on Free returns Error 1027 (fail-closed) | doc | confirmed | limits page (Oct 29, 2026) | Upgrade signal |
| `waitUntil` extends up to 30 s after response; shared across calls; unsettled promises canceled with a warning in Workers Logs; one rejected promise doesn't stop the others | doc | confirmed | developers.cloudflare.com/workers/runtime-apis/context/ | Claude patch design |
| Startup (global scope) must finish within 1 s | doc | confirmed | limits page (Oct 29, 2026) | SDK import at top level is fine |
| A save's pure-CPU work is under ~3 ms total inside workerd (HTMLRewriter 258 KB ~1 ms, SDK ctor ~2 ms, 100x parse+cleanUrl rounds to 0) | probe | measured (workerd clock is 1 ms granular) | `.context/probes/cloudflare/test/cpu.test.ts` | Plan choice |
| Same work in Node: SDK import 76 ms CPU (startup only), `new Anthropic()` 1.2 ms, parse+cleanUrl 0.005 ms, 24 KB Notion schema JSON parse 0.12 ms | probe | measured | `.context/probes/cloudflare/cpu-node.mjs` | Plan choice |
| `@cloudflare/vitest-pool-workers` is deprecated ("renamed to @cloudflare/vitest-plugin"); plugin 1.6.0 peers `vitest ^4.1.0 \|\| ^5.0.0` | repo | confirmed via `npm view` | npm registry, 2026-11-07 | Test stack |
| `cloudflare:test` in plugin 1.6.0 exports `createExecutionContext`, `waitOnExecutionContext`, `SELF` (deprecated), no `fetchMock` | probe | confirmed (import was `undefined`; d.ts has no export) | `node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts` | Mocking approach |
| Official mocking path is `msw@^3.0.0` + `@msw/cloudflare`, `setupNetwork()`, `network.enable()/resetHandlers()/disable()` in a setup file | doc + probe | confirmed, tests pass | developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/ (Oct 8, 2026); `.context/probes/cloudflare/test/` | Test stack |
| Unmocked requests pass through to the real network with only a `[MSW] Warning` | probe | confirmed (got a real 404 from example.com) | probe run, 2026-11-07 | Hermetic tests |
| `waitOnExecutionContext(ctx)` flushes `waitUntil` so the Notion PATCH is assertable after the response | probe | confirmed | `.context/probes/cloudflare/test/save.test.ts` | Test design |
| Full probe test run 3.7 s wall; `npm install` 4.5 s; `wrangler dev` ready in ~2 s; `wrangler 4.158.0`, `vitest 5.1.0`, `workerd 1.20261104.1` | probe | measured | probe run, 2026-11-07 | Per-milestone check |
| `wrangler secret bulk [file]` takes JSON or `.env` (`KEY=VALUE`), up to 100 secrets, stdin if no file; `secret put` is interactive or piped; both deploy a new version immediately | doc + probe | confirmed via `--help` | developers.cloudflare.com/workers/wrangler/commands/workers/ (Oct 26, 2026); `npx wrangler secret bulk --help` | Secrets workflow |
| `.dev.vars` (dotenv) next to the config is loaded by `wrangler dev` and vitest ("Using secrets defined in .dev.vars"); `.dev.vars.<env>` replaces it entirely | doc + probe | confirmed | developers.cloudflare.com/workers/configuration/secrets/ (Oct 15, 2026); probe | Local loop |
| `wrangler types` writes `./worker-configuration.d.ts` (16k lines), with `Env` including `vars` and `.dev.vars` keys; `--check` exits 1 when stale | doc + probe | confirmed | commands page; probe | Typed env |
| Cloudflare recommends `wrangler.jsonc` for new projects | doc | confirmed | developers.cloudflare.com/workers/wrangler/configuration/ (Oct 29, 2026) | Config format |
| Worker preflight: `OPTIONS /save` returns 204 with `Access-Control-Allow-Headers: content-type, x-satchel-key` | probe | confirmed via curl against `wrangler dev` | probe run | CORS |
| Chrome MV3: fetch from extension pages to a host in `host_permissions` is allowed cross-origin; without it, "treated as a cross-origin request" (normal CORS) | doc | confirmed | developer.chrome.com/docs/extensions/develop/concepts/network-requests | CORS |
| `https://*.workers.dev/*` is a valid match pattern (wildcard first, followed by a dot); `permissions.request` must run in a user gesture | doc | confirmed | developer.chrome.com/docs/extensions/develop/concepts/match-patterns; .../reference/api/permissions | CORS fallback |
| Workers Logs Free: 200,000 events/day, 3-day retention; Paid: 20M/month, 7 days. Enabled via `observability.enabled: true` (on by default for new Workers). Pricing moves to "Observability pricing" Dec 1, 2026 | doc | confirmed | developers.cloudflare.com/workers/observability/logs/workers-logs/ (Oct 12, 2026) | Observability |
| `wrangler tail` has `--status error`, `--search`, `--format json`, `--sampling-rate`; up to 10 concurrent viewers; no plan gating mentioned | doc + probe | confirmed via `--help` | developers.cloudflare.com/workers/observability/logs/real-time-logs/ (Jun 25, 2026) | Observability |
| Anthropic SDK 1.6.0 sends `authorization: Bearer <key>` and `anthropic-version: 2026-10-21`, not `x-api-key` | probe | observed in mocked request headers | probe run | Test assertions |
| workers.dev subdomain is "treated as a Free website"; nothing about Workers pausing or expiring on Free | doc | confirmed (absence) | developers.cloudflare.com/workers/configuration/routing/workers-dev/ | Month-three |

## Recommendation per decision

- **Plan: Free. One-way-ish (upgrading is trivial, so effectively two-way).** Measured CPU per save is under 3 ms against a 10 ms cap; subrequests are 4 to 6 against 50; requests are tens per day against 100,000. Runner-up: Paid at $5 for the 30 s CPU cap and 7-day logs. Not needed unless the upgrade signal below fires.
  - **Upgrade signal:** any `exceededCpu` outcome or Error 1102 in Workers Logs / `wrangler tail --status error`, or `cpuTimeMs` in invocation logs trending above ~7 ms. Error 1027 (daily cap) is not realistic here.
- **Test stack: `@cloudflare/vitest-plugin` 1.6.0 + `vitest` 5.1.0 + `msw@3` + `@msw/cloudflare`. One-way for the repo.** This is what the current docs and the live npm packages support; `vitest-pool-workers` is deprecated and won't get updates. Runner-up: pin `vitest@4.1` with the plugin. Only if a 5.x bug appears; the probe shows 5.1.0 works.
- **Mocking outbound Notion/Anthropic/oEmbed: MSW handlers per test (`network.use(http.post(url, resolver))`), with a catch-all fallback. Two-way.** `fetchMock` no longer exists in the plugin. Runner-up: inject a `fetch` function into the Worker's modules and `vi.fn()` it. More plumbing, and the Anthropic SDK uses global fetch anyway (its `fetch` option would need threading through too).
- **Asserting `waitUntil`: `createExecutionContext()` + `worker.fetch(req, env, ctx)` + `waitOnExecutionContext(ctx)`. Two-way.** Assert the PATCH handler hasn't fired before the flush and has after; that is the "phone banner doesn't wait on AI" check in code. Runner-up: `exports.default.fetch()` integration style, which can't observe the `waitUntil` boundary.
- **Secrets: `wrangler secret bulk` straight from `~/.config/satchel/secrets.env`. Two-way.** Zero echo, one command, creates and deploys a version. Caveat below about which keys are secrets vs vars. Runner-up: `wrangler secret put KEY < <(...)` per key, more steps, same result.
- **Config: `wrangler.jsonc` with `compatibility_flags: ["nodejs_compat"]` and `observability.enabled: true`. Two-way.** Cloudflare's stated recommendation; `$schema` gives editor validation. Runner-up: `wrangler.toml`, still fully supported.
- **CORS: Worker answers preflight; extension declares no `host_permissions` for the Worker. One-way (public API contract).** Works identically in the work profile, personal profile, iOS Shortcuts and curl, and the user-configured Worker URL means a static `host_permissions` entry can't know the host anyway. `Allow-Origin: *` is fine because the `x-satchel-key` header is the auth and preflight carries no credentials. Runner-up: `optional_host_permissions: ["https://*.workers.dev/*"]` requested from the options page in a click handler. Valid pattern, but it breaks for custom domains and adds a permission prompt for nothing.
- **Observability: Workers Logs on (3 days free) plus `wrangler tail --status error` while testing. Two-way.** Log one structured line per enrich outcome (`{event:"enrich", pageId, ok, error}`) so a failed AI patch is a one-line search in the dashboard. Runner-up: paid 7-day retention, only if 3 days keeps proving too short.

## Gotchas for the build agent

- **Package names:** `npm i -D wrangler @cloudflare/vitest-plugin vitest msw@^3.0.0 @msw/cloudflare typescript`, then `npm i @anthropic-ai/sdk`. Not `vitest-pool-workers`, not `defineWorkersConfig`. Config is `defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })], test: { setupFiles: ["./test/setup.ts"] } })`. Working copies: `.context/probes/cloudflare/vitest.config.ts`, `test/setup.ts`, `test/network.ts`, `test/save.test.ts`.
- **MSW passes unmocked requests through to the real network** (probe got a live 404 from example.com). Add a last-resort handler so tests can never hit Notion or Anthropic for real: in `beforeEach`, `network.use(http.all("*", () => HttpResponse.error()))`, then per-test handlers (added later via `use()`) take precedence. Unverified exact API; standard MSW ordering.
- **`network.enable()` takes no arguments** in `@msw/cloudflare` 0.2.0 (`onUnhandledRequest` isn't accepted; `tsc` fails if you pass it).
- **tsconfig needs `"skipLibCheck": true`** or MSW's WebSocket interceptor types fail against workers-types. Types list: `["./worker-configuration.d.ts", "@cloudflare/vitest-plugin/types"]`.
- **`import { env, exports } from "cloudflare:workers"`** for env and integration-style calls; `import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test"`. `SELF` is deprecated in favor of `exports.default.fetch()`.
- **Anthropic SDK 1.6.0 auth header is `authorization: Bearer ...`**, `anthropic-version: 2026-10-21`, user-agent `Anthropic/JS 1.6.0`. Assert on `authorization`, not `x-api-key`. Also set `new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 })` so the enrich step can't outlive the 30 s `waitUntil` window (SDK default timeout is 600 s with 2 retries).
- **`waitUntil` cap is 30 s shared across all calls per request.** Notion PATCH after Claude must also fit. Budget: Claude ≤ 20 s, Notion PATCH ≤ 5 s, and log a warning line if `Date.now()` since response exceeds 25 s.
- **CPU inside `waitUntil` counts toward the 10 ms.** Never do synchronous heavy work there (no big regex over page HTML, no re-parsing the whole page). Use HTMLRewriter streaming for title extraction, as the probe does (`src/index.ts` `extractTitle`), and stop reading after `</head>` if you can.
- **`wrangler secret bulk` deploys immediately** (new version). Run it after the first `wrangler deploy`, not before. Secrets vs vars: `NOTION_TOKEN`, `ANTHROPIC_API_KEY`, `SATCHEL_KEY` as secrets; `NOTION_DATABASE_ID`, `NOTION_DATA_SOURCE_ID` as `vars` in `wrangler.jsonc`. The secrets.env file holds all five, so either pass a filtered file (`grep -E '^(NOTION_TOKEN|ANTHROPIC_API_KEY|SATCHEL_KEY)=' ~/.config/satchel/secrets.env | npx wrangler secret bulk`) or accept the IDs becoming secrets too (harmless, but then they're invisible in the dashboard and `wrangler types` won't type them).
- **`.dev.vars`** goes next to `wrangler.jsonc`, dotenv syntax, and is read by both `wrangler dev` and vitest (log line: "Using secrets defined in .dev.vars"). `.gitignore` both `.dev.vars*` and `.env*`. For the build agent's local loop: `grep -E '^(NOTION_TOKEN|ANTHROPIC_API_KEY|SATCHEL_KEY)=' ~/.config/satchel/secrets.env > .dev.vars` inside one command, never cat it.
- **`wrangler types`** regenerates `worker-configuration.d.ts` (16k lines, commit it or gitignore it, either is fine); rerun after any `wrangler.jsonc` or `.dev.vars` change. `wrangler types --check` in CI catches drift.
- **Per-milestone check (measured):** `npx wrangler types && npx tsc --noEmit && npx vitest run` is about 6 s total cold. `npx wrangler dev` is ready in ~2 s and needs no login; curl `http://localhost:8787/health`.
- **CPU measurement locally:** workerd's `performance.now()` is 1 ms granular, so micro-timings read 0. For finer numbers run the pure functions under Node with `process.cpuUsage()` (`cpu-node.mjs`). For real numbers after deploy, Workers Logs invocation events carry `cpuTimeMs` and `wallTimeMs`; the dashboard Metrics tab shows CPU p50/p99. `wrangler dev --inspector-port 9229` exposes Chrome DevTools for a CPU profile (unverified beyond the port opening).
- **Free plan Error codes to recognize:** 1102 (CPU/resource limit, outcome `exceededCpu`), 1027 (daily request cap, fail-closed). Neither should appear for Satchel; either is the upgrade signal.
- **6 simultaneous outbound connections** per invocation; the 7th queues. Satchel's fan-out is at most 2 to 3 in flight, fine.

## Month-three failure question

Nothing on the free plan pauses, expires, or drops `waitUntil` work on its own. Verified absences: workers.dev routing docs and limits docs say nothing about inactivity or expiry; `waitUntil` cancellation is purely the 30 s cap and is logged. Things that do age out: Workers Logs retention is 3 days (so a failed AI patch from last week is gone; the Notion row with a raw title and no tags is the durable evidence), and Workers Logs pricing changes Dec 1, 2026 (watch for a new free-tier number). The Anthropic key type (`sk-ant-usr-`) and Notion connection access are the other lanes' concern.

## Still unverified

- **Whether `waitUntil` CPU counts toward the 10 ms cap** is inferred (CPU time is per invocation and `waitUntil` is the same invocation), not stated on the limits or context pages. Rung needed: doc sentence or a deployed probe with Workers Logs `cpuTimeMs`. Either way the budget holds by a wide margin.
- **Production `cpuTimeMs` for a real save** needs a deploy. Rung: probe after `wrangler login` and first deploy; one `wrangler tail --format json` line gives it.
- **MSW catch-all handler ordering** (`http.all("*")` in `beforeEach` losing to per-test `use()`): standard MSW semantics, not run here. Rung: probe, one test, 2 minutes.
- **Error 1027 fail-open vs fail-closed default** for a plain workers.dev route: docs say it depends on route fail mode without naming the default. Irrelevant at Satchel's volume.
- **Chrome CORS with `Allow-Origin: *` from a `chrome-extension://` origin popup** is doc-rung (normal CORS applies without host permissions); the probe only confirmed the Worker's preflight response via curl. Rung: load-unpacked smoke test in milestone 3.

## Dead ends

- `https://developers.cloudflare.com/workers/testing/vitest-integration/mocking/` is a 404; the live page is `.../mock-outbound-requests/`.
- `npm i @cloudflare/vitest-pool-workers vitest@latest` fails with ERESOLVE (peer `vitest ^4.1.0` vs 5.1.0) and the package is deprecated anyway. Don't retry.
- `fetchMock` from `cloudflare:test` is `undefined` in the plugin; don't port the old recipes.
- `wrangler/commands/` index page has no flag detail; use `.../commands/workers/` or `npx wrangler <cmd> --help` (works offline, no login).
