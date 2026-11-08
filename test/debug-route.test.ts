import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { previewBlock } from "../src/preview";
import type { LookupResult } from "../src/title";
import { network } from "./network";

// SAT-11: GET /debug/title?url= through worker.fetch. Outbound lookups are mocked with MSW;
// anything unmocked hits the catch-all in test/network.ts and fails as a network error.

const KEY = "test-satchel-key"; // vitest.config.ts binds this fake value
const BASE = "https://satchel.test";

type WorkerRequest = Request<unknown, IncomingRequestCfProperties>;

// key: null sends no x-satchel-key header. url: null sends no url param.
function debug(url: string | null, key: string | null = KEY, method = "GET"): WorkerRequest {
  const target = new URL(`${BASE}/debug/title`);
  if (url !== null) target.searchParams.set("url", url);
  const headers = new Headers();
  if (key !== null) headers.set("x-satchel-key", key);
  return new Request(target, { method, headers }) as WorkerRequest;
}

async function call(req: WorkerRequest, bindings: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function expectJson(res: Response, status: number): Promise<Record<string, unknown>> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  return (await res.json()) as Record<string, unknown>;
}

// Counts every outbound request, then fails it like the catch-all does.
function countOutbound() {
  const seen: string[] = [];
  network.use(
    http.all("*", ({ request }) => {
      seen.push(request.url);
      return HttpResponse.error();
    }),
  );
  return seen;
}

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

const PAGE = "https://example.com/post/hello-world";
const PAGE_HTML =
  '<!DOCTYPE html><html><head><title>Hello &amp; World</title><meta name="description" content="A post."></head><body>x</body></html>';

const X_ID = "1002103360646823936";
const OEMBED = "https://publish.x.com/oembed";
const X_OEMBED = JSON.stringify({
  url: `https://x.com/naval/status/${X_ID}`,
  author_name: "Naval",
  author_url: "https://twitter.com/naval",
  html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">How to Get Rich</p>&mdash; Naval (@naval)</blockquote>',
  type: "rich",
  version: "1.0",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("criterion 1: 401 without the key, 400 on a missing or invalid url", () => {
  it.each([
    ["missing", null],
    ["wrong", "nope"],
    ["wrong, same length", "x".repeat(KEY.length)],
    ["empty", ""],
    ["right key with a suffix", `${KEY}x`],
  ])("%s key → 401 unauthorized, no lookup", async (_label, key) => {
    const seen = countOutbound();
    const body = await expectJson(await call(debug(PAGE, key)), 401);
    expect(body).toEqual({ ok: false, error: "unauthorized" });
    expect(seen).toEqual([]);
  });

  it("fails closed: an unset SATCHEL_KEY rejects an empty and a non-empty key", async () => {
    const seen = countOutbound();
    const unset = { ...env, SATCHEL_KEY: "" } as Env;
    for (const key of ["", KEY]) {
      const body = await expectJson(await call(debug(PAGE, key), unset), 401);
      expect(body).toEqual({ ok: false, error: "unauthorized" });
    }
    expect(seen).toEqual([]);
  });

  it("checks the key before the url: no key and no url is 401, not 400", async () => {
    const body = await expectJson(await call(debug(null, null)), 401);
    expect(body).toEqual({ ok: false, error: "unauthorized" });
  });

  it.each([
    ["missing url", null, "invalid_body"],
    ["empty url", "", "invalid_body"],
    ["blank url", "   ", "invalid_body"],
    ["unparsable", "not a url", "invalid_url"],
    ["ftp scheme", "ftp://example.com/file", "invalid_url"],
    ["javascript scheme", "javascript:alert(1)", "invalid_url"],
    ["over 2000 chars", `https://example.com/${"a".repeat(2000)}`, "url_too_long"],
    // Same order as /save: length is checked before parsing.
    ["over 2000 chars and unparsable", `not a url ${"a".repeat(2000)}`, "url_too_long"],
  ])("%s → 400 %s, no lookup", async (_label, url, error) => {
    const seen = countOutbound();
    const body = await expectJson(await call(debug(url)), 400);
    expect(body).toEqual({ ok: false, error });
    expect(seen).toEqual([]);
  });

  it.each(["POST", "PUT", "DELETE", "OPTIONS"])("%s → 405 JSON naming GET", async (method) => {
    const res = await call(debug(PAGE, KEY, method));
    const body = await expectJson(res, 405);
    expect(body).toEqual({ ok: false, error: "method_not_allowed" });
    expect(res.headers.get("Allow")).toBe("GET");
  });
});

describe("criterion 2: JSON with ok on success and on lookup failure", () => {
  it("page: canonicalizes, runs the page lookup, returns the raw result with ms", async () => {
    const seen: string[] = [];
    network.use(
      http.get(PAGE, ({ request }) => {
        seen.push(request.url);
        return new HttpResponse(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }),
    );

    const body = await expectJson(await call(debug(`${PAGE}/?utm_source=x&fbclid=abc`)), 200);

    const { ms, ...rest } = body;
    expect(rest).toEqual({
      ok: true,
      kind: "page",
      stored: PAGE,
      title: "Hello & World",
      description: "A post.",
      source: "page",
      bytesRead: bytes(PAGE_HTML),
    });
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThanOrEqual(0);
    // The lookup ran on the stored (canonical) URL, not the raw one.
    expect(seen).toEqual([PAGE]);
  });

  it("x: a twitter.com status URL is looked up by post id and returns oEmbed's fields", async () => {
    network.use(
      http.get(OEMBED, () =>
        new HttpResponse(X_OEMBED, { headers: { "content-type": "application/json; charset=utf-8" } }),
      ),
    );

    const body = await expectJson(await call(debug(`https://twitter.com/naval/status/${X_ID}?s=20`)), 200);

    expect(body).toMatchObject({
      ok: true,
      kind: "x",
      stored: `https://x.com/i/status/${X_ID}`,
      title: "Naval: How to Get Rich",
      url: `https://x.com/naval/status/${X_ID}`,
      author: "Naval",
      handle: "naval",
      source: "x-oembed",
      bytesRead: bytes(X_OEMBED),
    });
    expect(typeof body.ms).toBe("number");
  });

  it("lookup failure (network error) → 200, ok: true, title null, source fallback", async () => {
    const seen = countOutbound();

    const body = await expectJson(await call(debug(PAGE)), 200);

    const { ms, ...rest } = body;
    expect(rest).toEqual({
      ok: true,
      kind: "page",
      stored: PAGE,
      title: null,
      source: "fallback",
      bytesRead: 0,
    });
    expect(typeof ms).toBe("number");
    expect(seen).toEqual([PAGE]);
  });

  it("upstream 403 → 200, ok: true, title null, source fallback", async () => {
    network.use(http.get(PAGE, () => new HttpResponse("Forbidden", { status: 403 })));

    const body = await expectJson(await call(debug(PAGE)), 200);

    expect(body).toMatchObject({ ok: true, kind: "page", stored: PAGE, title: null, source: "fallback" });
  });

  it("logs one debug_title line with kind, source and ms, and never the key or the url", async () => {
    network.use(
      http.get(PAGE, () =>
        new HttpResponse(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await call(debug(PAGE));
    expect(res.status).toBe(200);

    const lines = log.mock.calls.map((args) => args.map(String).join(" "));
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    const { ms, ...rest } = events[0]!;
    expect(rest).toEqual({ event: "debug_title", kind: "page", source: "page" });
    expect(typeof ms).toBe("number");
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain("example.com");
  });
});

// SAT-52: a later lead script calls the deployed /debug/title and feeds its JSON to
// previewBlock, so the JSON must carry what previewBlock needs for an X post's text.
describe("SAT-52: /debug/title's JSON is enough for previewBlock", () => {
  it("an X text post: `source` and the post text in `description`, which previewBlock turns into the paragraph", async () => {
    const oembed = JSON.stringify({
      url: `https://x.com/naval/status/${X_ID}`,
      author_name: "Naval",
      author_url: "https://twitter.com/naval",
      html:
        '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">How to Get Rich <a href="https://t.co/AbC123">https://t.co/AbC123</a></p>' +
        "&mdash; Naval (@naval)</blockquote>",
      type: "rich",
      version: "1.0",
    });
    network.use(
      http.get(OEMBED, () => new HttpResponse(oembed, { headers: { "content-type": "application/json; charset=utf-8" } })),
    );

    const body = await expectJson(await call(debug(`https://x.com/naval/status/${X_ID}`)), 200);

    expect(body).toMatchObject({
      source: "x-oembed",
      title: "Naval: How to Get Rich https://t.co/AbC123",
      description: "How to Get Rich https://t.co/AbC123",
    });
    expect(body).not.toHaveProperty("image");
    expect(previewBlock(body as unknown as LookupResult)).toEqual({
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "How to Get Rich" } }] },
    });
  });
});
