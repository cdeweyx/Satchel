# Lane 2: the Claude title-and-tags call

Date: 2026-11-07. Probes in `.context/probes/claude/` (`01-schema-and-key.mjs`, `02-five-inputs.mjs`, `worker/`). SDK `@anthropic-ai/sdk` 1.6.0, wrangler 4.158.0, esbuild 0.28.2, Node 24.22.1.

## Answer

- **The `sk-ant-usr-` key works.** One real `claude-haiku-5-5` call returned 200 from Node and again from a Worker running in local workerd. No new key needed. It's a "personal key" in Anthropic's current key model (acts as you; dies when you leave the org, otherwise only on its own expiry).
- **Structured outputs work as spec'd, with one schema change.** `output_config.format = {type: "json_schema", schema}` with `tags: {type: "array", minItems: 1, items: {type: "string", enum: [...30 tags]}}` is accepted. **`maxItems` is rejected with a 400** (`"For 'array' type, property 'maxItems' is not supported"`). Enforce "at most 3" in the prompt plus a client-side `slice(0, 3)`. All 5 probe outputs returned 1 to 2 tags anyway.
- **Effort is `output_config.effort: "low"`**, no beta header. Haiku 5.5 supports `low | medium | high | xhigh | max`, default `medium`. At `low` every probe showed `thinking_tokens: 0`.
- **Cost and latency, measured:** about 960 input + 45 output tokens per save with a 30-tag prompt, which is **$0.00012 per save** (the handoff's $0.0002 estimate holds with margin). Latency 0.9 to 1.5 s, avg 1.16 s, so it belongs in `ctx.waitUntil`, as planned.
- **The SDK runs on Workers with no compat flag.** `wrangler deploy --dry-run` bundles with no `nodejs_compat`, and `wrangler dev --local` served a real call (`navigator.userAgent === "Cloudflare-Workers"`). Bundle is 1.05 MB raw / 180 KB gzip, under the free plan's 3 MB gzip limit.
- **Month three:** an expired or revoked key returns `401 authentication_error` (SDK class `Anthropic.AuthenticationError`, `.status === 401`). The raw row is already in Notion by then; the Worker should catch it, leave the row untouched, and surface the failure on `GET /health`.

## Verified table

| Claim | Rung | Result | Source | Feeds |
|---|---|---|---|---|
| `sk-ant-usr-` key is accepted by `POST /v1/messages` | probe | 200, `end_turn`, 3 of 3 calls | `.context/probes/claude/01-schema-and-key.mjs` | Key choice: keep it |
| Key type name and what kills it | doc | "Personal key: acts as you... stops working when you lose access to the organization"; expiry set at creation, "Never" allowed unless the org has a max-expiry policy | [Authentication](https://platform.claude.com/docs/en/manage-claude/authentication.md) 2026-11-07 | Failure plan |
| `maxItems` on arrays is rejected | probe + doc | 400 `invalid_request_error`: "For 'array' type, property 'maxItems' is not supported". Doc: "Array `minItems` (only values 0 and 1 supported)"; "Array constraints beyond `minItems` of 0 or 1" not supported | probe 01 variant A; [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md) 2026-11-07 | Schema shape |
| `minItems: 1` + string `enum` of 30 accepted | probe | 200, tags came back from the enum every time | probe 01 variants B, C; probe 02 | Schema shape |
| Structured outputs supported on `claude-haiku-5-5` | doc + probe | Listed under `supportedModels`; probe confirms | same doc | Model is fine as fixed |
| `effort` values and default on Haiku 5.5 | doc | "Claude Haiku 5.5 supports all five effort levels, and `medium` is the default"; levels `low/medium/high/xhigh/max`; "no beta header required" | [Effort](https://platform.claude.com/docs/en/build-with-claude/effort.md) 2026-11-07 | Request shape |
| `effort: "low"` suppresses thinking on this task | probe | `output_tokens_details.thinking_tokens: 0` on 8 of 8 calls | probe 01, 02 | Cost, latency |
| Per-save cost | probe + doc | 4,835 in + 226 out over 5 saves = $0.000597, **$0.000119 per save**. Pricing: "$0.10 / MTok" in, "$0.50 / MTok" out for prompts up to 100,000 tokens | probe 02; [Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md) 2026-11-07 | Budget: ~$0.004/month at 1 save/day |
| Latency | probe | 885 to 1507 ms, avg 1,159 ms (5 calls, Node, Mac) | probe 02 | Must stay in `waitUntil` |
| SDK supports Cloudflare Workers | doc | Requirements list: "Cloudflare Workers." (no version) | [TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript.md) 2026-11-07 | Stack |
| No `nodejs_compat` needed | probe | `wrangler deploy --dry-run` with only `compatibility_date = "2026-11-01"`: "Total Upload: 1054.58 KiB / gzip: 180.17 KiB"; `wrangler dev --local` call returned 200 with `runtime: "Cloudflare-Workers"` | `.context/probes/claude/worker/` | wrangler.toml |
| Only `node:` reference in the bundle | probe | one string literal in an error message about `File` uploads (`node:buffer`), not an import | esbuild bundle grep | Nothing to shim |
| 401 shape and SDK class | probe + doc | Bad key from the Worker: `{"status":401,"type":"authentication_error","name":"AuthenticationError","msg":"... invalid x-api-key"}`. Doc: "After a key expires, requests made with it return a `401 authentication_error`" | worker probe; Authentication doc; [Errors](https://platform.claude.com/docs/en/api/errors.md) 2026-11-07 | Error handling |
| Refusal shape | doc | HTTP 200, `stop_reason: "refusal"`, output "might not match your schema"; "There is no server-side fallback for Claude Haiku 5.5" | Structured outputs doc; claude-api skill `shared/model-migration.md` § Migrating to Claude Haiku 5.5 | Error handling |
| Enum casing isn't guaranteed | doc | "Claude might return a value that differs from your schema only in capitalization... Compare enum values case-insensitively" | Structured outputs doc | Tag matching |
| Grammar compile latency on first use, 24 h cache | doc | "The first time you use a specific schema, there is additional latency while the grammar compiles"; "cached for 24 hours from last use"; changing only `description` doesn't invalidate | Structured outputs doc | Keep the schema byte-stable; tag list changes recompile |

## Recommendations per decision

1. **Keep the `sk-ant-usr-` key.** One-way (changing later costs a secret rotation, nothing else). Runner-up: mint a fresh `sk-ant-api03-` key at console.anthropic.com. Not needed; the only reason would be if this key was created with an expiry. Check its expiry on the Console API keys page before deploy and prefer "Never" for a secrets-manager-held key.

2. **Raw JSON schema, not `zodOutputFormat`.** Two-way. The schema is 6 lines, the tag enum is dynamic (read from Notion), and the Zod helper source has no handling for `maxItems`, so it'd pass through and 400 just the same. Runner-up: `client.messages.parse()` with Zod for typed `parsed_output`. Skip it; `JSON.parse` on the single text block plus a tag filter is enough.

3. **Enforce the 3-tag cap client-side.** One-way given the API rejects `maxItems`. Prompt says "1 to 3", schema says `minItems: 1`, Worker does `tags.filter(inAllowedSet).slice(0, 3)` with a case-insensitive match against the live Notion option names.

4. **`effort: "low"`, `max_tokens: 512`, no `thinking` param.** Two-way. Thinking stayed at zero in every probe, and 512 leaves room if it ever thinks. Runner-up: `medium` (the default). Only switch if tag quality is bad in the real test pass.

5. **Cache the system prompt? No.** Two-way. The prompt is ~900 tokens; Haiku 5.5's minimum cacheable prefix is 512 so it would cache, but a 5-minute cache on a tool used a few times a day never hits. Revisit only if volume changes.

6. **Error handling: catch, log, move on; surface on `/health`.** One-way (it's the "never lose a save" promise). Detail in Month three below.

## The request, exactly

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 });

const r = await client.messages.create({
  model: "claude-haiku-5-5",
  max_tokens: 512,
  output_config: {
    effort: "low",
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "The cleaned title." },
          tags: {
            type: "array",
            minItems: 1,            // maxItems is a 400; cap in code
            items: { type: "string", enum: allowedTags },
            description: "1 to 3 tags from the allowed list. Never more than 3.",
          },
        },
        required: ["title", "tags"],
        additionalProperties: false,
      },
    },
  },
  system: SYSTEM,
  messages: [{ role: "user", content: userText }],
});

if (r.stop_reason !== "end_turn") throw new Error(`stop_reason ${r.stop_reason}`);
const text = r.content.find((b) => b.type === "text")?.text ?? "";
const out = JSON.parse(text) as { title: string; tags: string[] };
```

Read the text block by `type`, not `content[0]`; Haiku 5.5 can emit a `thinking` block first.

## System prompt draft

Probe 02 ran this verbatim. Outputs: X post became `Paul Graham: Founders often build things nobody wants and talk to users too late`; `| The Figma Blog` and `- The New York Times` suffixes dropped; `(3) ` and ` - YouTube` dropped; title-less GitHub URL got its PR title from the page text; tags were 1 or 2 per save, all from the list.

```
You clean up titles for links saved to a personal reading database and pick tags for them.

Title rules:
- Keep the author's own title. Fix only what is noise.
- Drop site-name suffixes and prefixes like " | The Acme Blog", " - Medium", " — The New York Times", " · Substack".
- Drop leading "(12) " notification counts and trailing " - YouTube".
- For X / Twitter posts (input starts with "X post by"), write "Author: short gist" where the gist is a plain 4 to 10 word summary of the post, not a quote.
- If there is no usable title, write a short descriptive one from the URL and any page text given.
- Never add commentary, emoji, or quotes around the title. Sentence case is fine; don't force Title Case.

Tag rules:
- Pick 1 to 3 tags from the allowed list only. Fewer is better: one tag when one fits, three only when all three clearly apply.
- Never invent a tag. If nothing fits, pick the single closest one.

Allowed tags: <comma-separated live Notion options>
```

User message format (one of):
- `X post by <Author> (@handle): "<oEmbed text>"\nURL: <url>`
- `Title: <raw title>\nDescription: <og:description, if any>\nURL: <url>`
- `Title: (none)\nURL: <url>\nPage text: <first ~300 chars>`

One thing to tune in the test pass: the News title came back in sentence case (`Fed holds rates steady...`) because the prompt allows it. If you'd rather keep the publisher's casing, change that line to "Keep the original capitalization."

## Month three: the key dies

What happens: requests return `401 authentication_error` (expired, revoked, disabled, or you're removed from the org; all the same status). The SDK throws `Anthropic.AuthenticationError`; it does not retry 401s. Nothing else changes: Notion already has the row with the raw title and no tags, because the Worker wrote it before `waitUntil` started.

What the Worker should do:
- In the `waitUntil` task, wrap the Claude call in `try/catch`. On any error, `console.error` the class name, `status`, and `_request_id` (never the key or the body) and return. The row stays as written.
- Keep a tiny counter: `env.SATCHEL_STATE` KV (free plan: 100k reads/day, 1k writes/day, fine) with `claude_last_error = {at, status, type}` and `claude_last_ok = at`. Write on each outcome.
- `GET /health` returns `{ notion: "ok", claude: "ok" | "auth_failed since <date>" | "error <type> at <date>" }`. You'll see it on your phone the first time a save lands with no tags and you check.
- Order the catch chain: `AuthenticationError` (401, don't retry, flag `auth_failed`), `PermissionDeniedError` (403, same), `RateLimitError` (429, let the SDK's one retry handle it), `APIConnectionError` before `APIError` (the TS SDK makes connection errors a subclass of `APIError`).
- Don't add `fallbacks`; Haiku 5.5 has no server-side fallback and a model list is a 400.

Prevention: when you look at the key in the Console, check its **Expires** column. If it's set, note the date; Anthropic emails 7 days before for keys with 14+ day lifetimes. Rotation is `wrangler secret put ANTHROPIC_API_KEY`, no redeploy.

## Gotchas for the build agent

- **`maxItems` = 400.** Also `minLength`, `maxLength`, `minimum`, `maximum`, `pattern` beyond simple regex, `additionalProperties` other than `false`. Only `minItems: 0 | 1` on arrays.
- **Schema change = grammar recompile** (extra latency on first call, cached 24 h). The enum is the live tag list, so adding a Notion tag recompiles once. Editing `description` fields doesn't.
- **Enum casing isn't guaranteed.** Match returned tags to Notion options case-insensitively, then write the Notion option's exact name.
- **`output_tokens_details.thinking_tokens`** is in `usage`; log it if you ever want to confirm `low` is holding.
- **No `temperature`, `top_p`, `top_k`** on Haiku 5.5 (non-default values 400). Don't send them.
- **No assistant prefill** (400). Structured outputs replace it.
- **SDK auth header:** the 401 body says `invalid x-api-key`, but `@anthropic-ai/sdk` 1.6.0 sends `apiKey` as `Authorization: Bearer <key>` (corrected in build, 2026-11-08, SAT-14: checked in the installed `client.mjs` and the live `/v1/models` probe); `ANTHROPIC_API_KEY` as a Wrangler secret plus `new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })` is the shape. Don't rely on `process.env`; it doesn't exist in Workers without `nodejs_compat`.
- **SDK timeout unit is milliseconds** in TypeScript. Default 10 min; set `timeout: 20_000` so a hung call can't eat the Worker's `waitUntil` budget (30 s CPU is irrelevant here, but wall clock still matters on free plan).
- **Pricing has two rate cards** split at a 100,000-token prompt. Irrelevant at ~1k tokens, but don't paste page bodies into the prompt.
- **Repo has no `.gitignore` yet.** `.context/` holds `node_modules/`, `dev.log`, and bundles from these probes. Add `.context/` to `.gitignore` before the first commit.
- **Pin `anthropic-version`? No.** SDK 1.x sends `2026-10-21` itself.

## Still unverified

- **Behaviour under `wrangler deploy` to real Cloudflare.** Probed in local workerd only (same runtime binary, but not the edge). Needs: a real deploy once `wrangler login` is done (probe rung).
- **Whether the user's key has an expiry set.** The Console shows it; the API doesn't expose it to a non-admin key. Needs: a look at platform.claude.com/settings/keys (doc rung, user action).
- **Tag quality on real saves with the real 30 options.** Probe used a made-up list; 5 of 5 looked right. Needs: the build's test pass (probe rung).
- **`zodOutputFormat` stripping `maxItems`.** Grep of `helpers/zod.mjs` found no handling, so I expect it to 400 too, but didn't run it. Moot if you take recommendation 2.

## Dead ends

- Fetching docs for a `sk-ant-usr-` prefix: the Authentication page never names prefixes beyond `sk-ant-api...`. The probe answered it instead; don't re-search.
- `esbuild --platform=node` for the Worker: unnecessary; `--platform=browser --conditions=workerd,worker,browser` and plain wrangler both work.

## What this means for the plan

The Claude step is the easy part. Fixed model, raw schema with `minItems: 1` and an enum, `effort: "low"`, `max_tokens: 512`, one `try/catch` that never throws past `waitUntil`, cap tags at 3 in code, match case-insensitively. The key stays. Add KV-backed `/health` so a dead key is visible. Budget is about a tenth of a cent per save.
