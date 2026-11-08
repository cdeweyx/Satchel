import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse } from "../src/contract";
import { health } from "../src/health";
import worker from "../src/index";

// vi.mock in this pool calls AsyncLocalStorage.prototype.disable(), which workerd doesn't
// implement ("asyncLocalStorage.disable() is not implemented"). Vitest only calls it as a Node
// perf optimization, so a no-op is safe. Runs before the imports above are evaluated.
await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  AsyncLocalStorage.prototype.disable = function () {};
});

// Criterion 5 only: health() is a spy that calls through to the real stub. Every other test
// gets the real stub (and the real handleSave stub); criterion 5 overrides one call at a time.
vi.mock("../src/health", { spy: true });

const KEY = "test-satchel-key"; // vitest.config.ts binds this fake value
const BASE = "https://satchel.test";

type Init = { method?: string; key?: string; body?: string; headers?: Record<string, string> };

type WorkerRequest = Request<unknown, IncomingRequestCfProperties>;

function request(path: string, init: Init = {}): WorkerRequest {
  const headers = new Headers(init.headers);
  if (init.key !== undefined) headers.set("x-satchel-key", init.key);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  }) as WorkerRequest;
}

async function call(req: WorkerRequest, bindings: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function saveBody(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

const valid = { url: "https://example.com/a", status: "later" };

// key: null sends no x-satchel-key header (undefined would fall back to the right key).
function post(body: string, key: string | null = KEY): WorkerRequest {
  return request("/save", { method: "POST", key: key ?? undefined, body });
}

async function expectJson(res: Response, status: number, body: Record<string, unknown>) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(await res.json()).toEqual(body);
}

afterEach(() => {
  vi.mocked(health).mockClear();
});

describe("criterion 1: every response is JSON with ok and open CORS", () => {
  const cases: Array<{
    name: string;
    req: () => WorkerRequest;
    setup?: () => void;
    status: number;
    body: Record<string, unknown>;
  }> = [
    { name: "200 GET /health", req: () => request("/health"), status: 200, body: { ok: true } },
    {
      name: "400 invalid_body",
      req: () => post("not json"),
      status: 400,
      body: { ok: false, error: "invalid_body" },
    },
    {
      name: "400 invalid_url",
      req: () => post(saveBody({ url: "not a url", status: "later" })),
      status: 400,
      body: { ok: false, error: "invalid_url" },
    },
    {
      name: "400 url_too_long",
      req: () => post(saveBody({ url: `https://example.com/${"a".repeat(2000)}`, status: "later" })),
      status: 400,
      body: { ok: false, error: "url_too_long" },
    },
    {
      name: "401 unauthorized",
      req: () => post(saveBody(valid), null),
      status: 401,
      body: { ok: false, error: "unauthorized" },
    },
    { name: "404 not_found", req: () => request("/nope"), status: 404, body: { ok: false, error: "not_found" } },
    {
      name: "405 GET /save",
      req: () => request("/save"),
      status: 405,
      body: { ok: false, error: "method_not_allowed" },
    },
    {
      name: "405 POST /health",
      req: () => request("/health", { method: "POST" }),
      status: 405,
      body: { ok: false, error: "method_not_allowed" },
    },
    {
      // A valid, authorized save reaches the real handleSave stub, which answers 500.
      name: "500 from handleSave stub",
      req: () => post(saveBody(valid)),
      status: 500,
      body: { ok: false, error: "internal" },
    },
    {
      name: "500 internal from the top-level catch",
      req: () => request("/health"),
      setup: () => vi.mocked(health).mockRejectedValueOnce(new Error("boom")),
      status: 500,
      body: { ok: false, error: "internal" },
    },
    {
      name: "503 from health()",
      req: () => request("/health", { key: KEY }),
      setup: () =>
        vi.mocked(health).mockResolvedValueOnce({ status: 503, body: { ok: false, notion: "auth_failed" } }),
      status: 503,
      body: { ok: false, notion: "auth_failed" },
    },
  ];

  it.each(cases)("$name", async ({ req, setup, status, body }) => {
    setup?.();
    const res = await call(req());
    await expectJson(res, status, body);
    expect(typeof body.ok).toBe("boolean");
  });

  it("405s name the allowed methods", async () => {
    expect((await call(request("/save", { method: "PUT" }))).headers.get("Allow")).toBe("POST, OPTIONS");
    expect((await call(request("/health", { method: "DELETE" }))).headers.get("Allow")).toBe("GET");
  });
});

describe("criterion 2: x-satchel-key on /save", () => {
  it.each([
    ["missing", null],
    ["wrong", "nope"],
    ["wrong, same length", "x".repeat(KEY.length)],
    ["empty", ""],
    ["right key with a suffix", `${KEY}x`],
  ])("%s key → 401 unauthorized", async (_label, key) => {
    await expectJson(await call(post(saveBody(valid), key)), 401, { ok: false, error: "unauthorized" });
  });

  it("checks the key before reading the body (401 even when the body is junk)", async () => {
    await expectJson(await call(post("not json", "nope")), 401, { ok: false, error: "unauthorized" });
  });

  it("the right key gets past auth to validation and handleSave", async () => {
    await expectJson(await call(post("not json")), 400, { ok: false, error: "invalid_body" });
    await expectJson(await call(post(saveBody(valid))), 500, { ok: false, error: "internal" });
  });

  describe("fails closed when SATCHEL_KEY is unset or blank", () => {
    const blanks: Array<[string, unknown]> = [
      ["empty", ""],
      ["whitespace", "   "],
      ["undefined", undefined],
    ];

    it.each(blanks)("SATCHEL_KEY %s: an empty or matching header still 401s on /save", async (_label, secret) => {
      const bindings = { ...env, SATCHEL_KEY: secret } as unknown as Env;
      for (const key of ["", "   ", null, "anything"]) {
        await expectJson(await call(post(saveBody(valid), key), bindings), 401, {
          ok: false,
          error: "unauthorized",
        });
      }
    });

    it.each(blanks)("SATCHEL_KEY %s: a presented key reaches health() as wrong", async (_label, secret) => {
      const bindings = { ...env, SATCHEL_KEY: secret } as unknown as Env;
      echoKeyState();
      const res = await call(request("/health", { key: (secret as string | undefined) ?? "" }), bindings);
      await expectJson(res, 200, { ok: true, keyState: "wrong" });
    });
  });
});

describe("criterion 3: body validation on POST /save", () => {
  const bad: Array<[string, string, string]> = [
    ["not JSON", "{url:", "invalid_body"],
    ["empty body", "", "invalid_body"],
    ["JSON null", "null", "invalid_body"],
    ["JSON array", saveBody([valid] as unknown as Record<string, unknown>), "invalid_body"],
    ["JSON string", JSON.stringify("https://example.com"), "invalid_body"],
    ["missing url", saveBody({ status: "later" }), "invalid_body"],
    ["url not a string", saveBody({ url: 42, status: "later" }), "invalid_body"],
    ["url blank after trim", saveBody({ url: "   ", status: "later" }), "invalid_body"],
    ["missing status", saveBody({ url: "https://example.com" }), "invalid_body"],
    ["status outside the three", saveBody({ url: "https://example.com", status: "archived" }), "invalid_body"],
    ["status wrong case", saveBody({ url: "https://example.com", status: "Later" }), "invalid_body"],
    ["title not a string", saveBody({ ...valid, title: 7 }), "invalid_body"],
    ["title null", saveBody({ ...valid, title: null }), "invalid_body"],
    ["unparsable url", saveBody({ url: "not a url", status: "later" }), "invalid_url"],
    ["non-http scheme", saveBody({ url: "javascript:alert(1)", status: "later" }), "invalid_url"],
    ["ftp scheme", saveBody({ url: "ftp://example.com/f", status: "later" }), "invalid_url"],
    ["url over 2000 chars", saveBody({ url: `https://example.com/${"a".repeat(1981)}`, status: "later" }), "url_too_long"],
    ["over 2000 and unparsable: length wins", saveBody({ url: "x".repeat(2001), status: "later" }), "url_too_long"],
  ];

  it.each(bad)("%s → 400 %s", async (_label, body, error) => {
    await expectJson(await call(post(body)), 400, { ok: false, error });
  });

  // Valid bodies pass validation and reach the handleSave stub (500 internal), not a 400.
  it.each([
    ["each status: later", { url: "https://example.com", status: "later" }],
    ["each status: read", { url: "https://example.com", status: "read" }],
    ["each status: favorite", { url: "https://example.com", status: "favorite" }],
    ["with a title", { ...valid, title: "A Title" }],
    ["http scheme", { url: "http://example.com", status: "later" }],
    ["url padded with spaces", { url: "  https://example.com  ", status: "later" }],
    ["url exactly 2000 chars", { url: `https://example.com/${"a".repeat(1980)}`, status: "later" }],
  ])("%s passes validation", async (_label, fields) => {
    await expectJson(await call(post(saveBody(fields))), 500, { ok: false, error: "internal" });
  });
});

describe("criterion 4: OPTIONS /save preflight", () => {
  it("returns 204 with the plan's CORS headers and no body", async () => {
    const res = await call(
      request("/save", {
        method: "OPTIONS",
        headers: {
          Origin: "chrome-extension://abc",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, x-satchel-key",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("content-type, x-satchel-key");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(await res.text()).toBe("");
  });

  it("needs no key", async () => {
    expect((await call(request("/save", { method: "OPTIONS" }))).status).toBe(204);
  });
});

// Makes the mocked health() put the keyState it was given into the body, so the test reads it
// off the Response.
function echoKeyState() {
  vi.mocked(health).mockImplementationOnce(async (_env, keyState) => ({
    status: 200,
    body: { ok: true, keyState } as HealthResponse,
  }));
}

describe("criterion 5: /health is exactly json(result.status, result.body) from health()", () => {
  it("a 503 from health() propagates as 503 with its body", async () => {
    vi.mocked(health).mockResolvedValueOnce({
      status: 503,
      body: { ok: false, notion: "ok", claude: "auth_failed", oembed: "error 500" },
    });
    await expectJson(await call(request("/health", { key: KEY })), 503, {
      ok: false,
      notion: "ok",
      claude: "auth_failed",
      oembed: "error 500",
    });
  });

  it("a 401 from health() propagates as 401", async () => {
    vi.mocked(health).mockResolvedValueOnce({ status: 401, body: { ok: false, error: "unauthorized" } });
    await expectJson(await call(request("/health", { key: "nope" })), 401, { ok: false, error: "unauthorized" });
  });

  it("without a mock override, the real stub's liveness answer comes through", async () => {
    await expectJson(await call(request("/health")), 200, { ok: true });
  });

  it.each([
    ["no header", undefined, "none"],
    ["wrong key", "nope", "wrong"],
    ["empty key", "", "wrong"],
    ["right key", KEY, "ok"],
  ])("%s → keyState %s", async (_label, key, keyState) => {
    echoKeyState();
    await expectJson(await call(request("/health", { key })), 200, { ok: true, keyState });
  });

  it("a wrong key isn't special-cased: whatever health() returns is the response", async () => {
    // The real stub answers 200 {ok:true} for any keyState; SAT-16 makes wrong a 401.
    await expectJson(await call(request("/health", { key: "nope" })), 200, { ok: true });
  });
});
