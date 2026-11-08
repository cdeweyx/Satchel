import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { health } from "../src/health";
import worker from "../src/index";
import { network } from "./network";

// Shapes follow research 01 to 03 (2026-11-07): Notion's `object_not_found` error body, the
// Anthropic 401 `authentication_error` body, the models list page, X oEmbed JSON with `html`,
// and X's 404 "Nothing to see here" HTML.

const NOTION = "https://api.notion.com/v1/data_sources/test-data-source-id";
const MODELS = "https://api.anthropic.com/v1/models";
const OEMBED = "https://publish.x.com/oembed";
// vitest.config.ts bindings (fake values).
const SATCHEL_KEY = "test-satchel-key";
const NOTION_TOKEN = "test-notion-token";
const ANTHROPIC_KEY = "test-anthropic-key";

type Seen = { method: string; url: string; headers: Record<string, string> };

// Records every outbound request: the three probe endpoints plus anything else, which still
// fails as a network error after being counted.
function recorder() {
  const seen: Seen[] = [];
  const record = (request: { method: string; url: string; headers: Headers }) => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    seen.push({ method: request.method, url: request.url, headers });
  };
  const forHost = (host: string) => seen.filter((s) => new URL(s.url).host === host);
  return { seen, record, forHost };
}

type Resolver = () => Response | Promise<Response>;

const notionOk: Resolver = () =>
  HttpResponse.json({ object: "data_source", id: "test-data-source-id", properties: {} });
const modelsOk: Resolver = () =>
  HttpResponse.json({
    data: [
      {
        type: "model",
        id: "claude-haiku-5-5",
        display_name: "Claude Haiku 5.5",
        created_at: "2026-10-01T00:00:00Z",
      },
    ],
    has_more: true,
    first_id: "claude-haiku-5-5",
    last_id: "claude-haiku-5-5",
  });
const oembedOk: Resolver = () =>
  HttpResponse.json({
    url: "https://twitter.com/jack/status/20",
    author_name: "jack",
    author_url: "https://twitter.com/jack",
    html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://twitter.com/jack/status/20">March 21, 2006</a></blockquote>\n',
    type: "rich",
    provider_name: "Twitter",
  });

function mock(overrides: { notion?: Resolver; models?: Resolver; oembed?: Resolver } = {}) {
  const r = recorder();
  network.use(
    http.get(NOTION, ({ request }) => {
      r.record(request);
      return (overrides.notion ?? notionOk)();
    }),
    http.get(MODELS, ({ request }) => {
      r.record(request);
      return (overrides.models ?? modelsOk)();
    }),
    http.get(OEMBED, ({ request }) => {
      r.record(request);
      return (overrides.oembed ?? oembedOk)();
    }),
    http.all("*", ({ request }) => {
      r.record(request);
      return HttpResponse.error();
    }),
  );
  return r;
}

const notionError = (status: number, code: string) =>
  HttpResponse.json({ object: "error", status, code, message: `mocked ${code}` }, { status });

const anthropicError = (status: number, type: string) =>
  HttpResponse.json(
    { type: "error", error: { type, message: "invalid x-api-key" } },
    { status, headers: { "request-id": "req_health_1" } },
  );

const xNotFoundHtml = () =>
  new HttpResponse("<!DOCTYPE html><html><body><h1>Nothing to see here</h1></body></html>", {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

type WorkerRequest = Request<unknown, IncomingRequestCfProperties>;

async function callHealth(key?: string): Promise<Response> {
  const headers = new Headers();
  if (key !== undefined) headers.set("x-satchel-key", key);
  const req = new Request("https://satchel.test/health", { headers }) as WorkerRequest;
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("probe requests", () => {
  it("one GET to each endpoint, with the right auth and query, and nothing else", async () => {
    const r = mock();
    const out = await health(env, "ok");
    expect(out).toEqual({ status: 200, body: { ok: true, notion: "ok", claude: "ok", oembed: "ok" } });
    expect(r.seen).toHaveLength(3);

    const [n] = r.forHost("api.notion.com");
    expect(n?.method).toBe("GET");
    expect(n?.url).toBe(NOTION);
    expect(n?.headers["authorization"]).toBe(`Bearer ${NOTION_TOKEN}`);
    expect(n?.headers["notion-version"]).toBe("2026-03-11");

    // Same auth the SAT-14 client sends: SDK 1.6.0 puts apiKey in a bearer header.
    const [a] = r.forHost("api.anthropic.com");
    expect(a?.method).toBe("GET");
    const models = new URL(a!.url);
    expect(models.origin + models.pathname).toBe(MODELS);
    expect(models.searchParams.get("limit")).toBe("1");
    expect(a?.headers["authorization"]).toBe(`Bearer ${ANTHROPIC_KEY}`);
    expect(a?.headers["x-api-key"]).toBeUndefined();
    expect(a?.headers["anthropic-version"]).toBeTruthy();
    expect(a?.headers["x-stainless-retry-count"]).toBe("0");

    const [o] = r.forHost("publish.x.com");
    expect(o?.method).toBe("GET");
    const oembed = new URL(o!.url);
    expect(oembed.origin + oembed.pathname).toBe(OEMBED);
    expect(oembed.searchParams.get("url")).toBe("https://x.com/jack/status/20");
    expect(oembed.searchParams.get("omit_script")).toBe("true");
    expect(oembed.searchParams.get("dnt")).toBe("true");
    expect(o?.headers["authorization"]).toBeUndefined();
  });
});

describe("criterion 1: a dead Anthropic key", () => {
  it("models 401 → claude: auth_failed, 503, one attempt (no retry)", async () => {
    const r = mock({ models: () => anthropicError(401, "authentication_error") });
    const out = await health(env, "ok");
    expect(out).toEqual({
      status: 503,
      body: { ok: false, notion: "ok", claude: "auth_failed", oembed: "ok" },
    });
    expect(r.forHost("api.anthropic.com")).toHaveLength(1);
  });

  it("models 403 → claude: auth_failed", async () => {
    mock({ models: () => anthropicError(403, "permission_error") });
    const out = await health(env, "ok");
    expect(out.status).toBe(503);
    expect(out.body.claude).toBe("auth_failed");
  });

  it("through the router: keyed GET /health is 503 with claude: auth_failed", async () => {
    mock({ models: () => anthropicError(401, "authentication_error") });
    const res = await callHealth(SATCHEL_KEY);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: false, notion: "ok", claude: "auth_failed", oembed: "ok" });
  });
});

describe("criterion 2: Notion can't see the data source", () => {
  it("Notion 404 object_not_found → notion: not_found, 503", async () => {
    mock({ notion: () => notionError(404, "object_not_found") });
    const out = await health(env, "ok");
    expect(out).toEqual({
      status: 503,
      body: { ok: false, notion: "not_found", claude: "ok", oembed: "ok" },
    });
  });

  it("object_not_found maps to not_found whatever the status", async () => {
    mock({ notion: () => notionError(400, "object_not_found") });
    expect((await health(env, "ok")).body.notion).toBe("not_found");
  });

  it("Notion 401 unauthorized → notion: auth_failed", async () => {
    mock({ notion: () => notionError(401, "unauthorized") });
    const out = await health(env, "ok");
    expect(out.status).toBe(503);
    expect(out.body.notion).toBe("auth_failed");
  });

  it("Notion 500 → notion: error 500, one request (no retry)", async () => {
    const r = mock({ notion: () => notionError(500, "internal_server_error") });
    expect((await health(env, "ok")).body.notion).toBe("error 500");
    expect(r.forHost("api.notion.com")).toHaveLength(1);
  });
});

describe("criterion 3: X oEmbed down", () => {
  it("oEmbed HTML 404 → oembed: error 404, 503", async () => {
    mock({ oembed: xNotFoundHtml });
    const out = await health(env, "ok");
    expect(out).toEqual({
      status: 503,
      body: { ok: false, notion: "ok", claude: "ok", oembed: "error 404" },
    });
  });

  it("200 JSON with an empty html → oembed: error 200", async () => {
    mock({ oembed: () => HttpResponse.json({ type: "rich", html: "" }) });
    const out = await health(env, "ok");
    expect(out.status).toBe(503);
    expect(out.body.oembed).toBe("error 200");
  });

  it("200 that isn't JSON → oembed: error 200", async () => {
    mock({ oembed: () => new HttpResponse("<html></html>", { headers: { "content-type": "text/html" } }) });
    expect((await health(env, "ok")).body.oembed).toBe("error 200");
  });
});

describe("network failure and timeouts", () => {
  it("every endpoint unreachable → error 0 on all three, 503", async () => {
    const fail = () => HttpResponse.error();
    mock({ notion: fail, models: fail, oembed: fail });
    const out = await health(env, "ok");
    expect(out).toEqual({
      status: 503,
      body: { ok: false, notion: "error 0", claude: "error 0", oembed: "error 0" },
    });
  });

  it("a hung oEmbed times out at about 3 s as error 0 and doesn't hold the other probes", async () => {
    mock({
      oembed: async () => {
        await delay("infinite");
        return HttpResponse.json({});
      },
    });
    const started = Date.now();
    const out = await health(env, "ok");
    const elapsed = Date.now() - started;
    expect(out).toEqual({
      status: 503,
      body: { ok: false, notion: "ok", claude: "ok", oembed: "error 0" },
    });
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);
});

describe("criterion 4: through the router", () => {
  it("right key, all probes ok → 200 {ok, notion, claude, oembed} with open CORS", async () => {
    const r = mock();
    const res = await callHealth(SATCHEL_KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, notion: "ok", claude: "ok", oembed: "ok" });
    expect(r.seen).toHaveLength(3);
    // Never returns a key or token.
    for (const secret of [SATCHEL_KEY, NOTION_TOKEN, ANTHROPIC_KEY]) expect(text).not.toContain(secret);
  });

  it("no key → 200 {ok: true} and no probe request", async () => {
    const r = mock();
    const res = await callHealth();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(r.seen).toHaveLength(0);
  });

  it("wrong key → 401 unauthorized and no probe request", async () => {
    const r = mock();
    const res = await callHealth("not-the-key");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(r.seen).toHaveLength(0);
  });

  it("health() directly: none → 200 {ok: true}, wrong → 401, neither probes", async () => {
    const r = mock();
    expect(await health(env, "none")).toEqual({ status: 200, body: { ok: true } });
    expect(await health(env, "wrong")).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(r.seen).toHaveLength(0);
  });
});
