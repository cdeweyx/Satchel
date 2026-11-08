import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROPS } from "../src/config";
import type { EnrichJob } from "../src/contract";
import { enrich, nameUnchanged } from "../src/enrich";
import { lookupTitle } from "../src/title";
import { PAGE_UA } from "../src/title/page";
import { network } from "./network";

const API = "https://api.notion.com/v1";
const PAGE_ID = "11111111-2222-3333-4444-555555555555";
const PAGE_URL = `${API}/pages/${PAGE_ID}`;

const X_ID = "1002103360646823936";
const X_STORED = `https://x.com/i/status/${X_ID}`;
const X_CANONICAL = `https://x.com/naval/status/${X_ID}`;
const OEMBED = "https://publish.x.com/oembed";

// --- Recording every outbound request, in order ---

type Seen = { method: string; url: string; userAgent: string | null; body: unknown; at: number };
type Req = {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
  clone(): { text(): Promise<string> };
};
type Record_ = (r: Req) => Promise<void>;

function recorder() {
  const seen: Seen[] = [];
  const t0 = performance.now();
  const record: Record_ = async (request) => {
    const text = request.method === "GET" ? "" : await request.clone().text();
    seen.push({
      method: request.method,
      url: request.url,
      userAgent: request.headers.get("user-agent"),
      body: text ? JSON.parse(text) : undefined,
      at: performance.now() - t0,
    });
  };
  return { seen, record };
}

// A re-read page whose Name is `name`, split across two rich-text runs to exercise the join.
function notionPage(name: string, url: string | null = X_STORED) {
  const half = Math.ceil(name.length / 2);
  const run = (s: string) => ({
    type: "text",
    text: { content: s, link: null },
    annotations: {},
    plain_text: s,
    href: null,
  });
  return {
    object: "page",
    id: PAGE_ID,
    properties: {
      [PROPS.name]: { id: "title", type: "title", title: [run(name.slice(0, half)), run(name.slice(half))] },
      [PROPS.url]: { id: "u", type: "url", url },
    },
  };
}

// Mocks the re-read (GET) and the patch (PATCH) of PAGE_ID, recording both.
function mockNotion(
  record: Record_,
  opts: {
    name: string;
    url?: string | null;
    rereadStatus?: number;
    patchStatus?: number;
    rereadDelayMs?: number;
  },
) {
  network.use(
    http.get(PAGE_URL, async ({ request }) => {
      await record(request);
      if (opts.rereadDelayMs) await new Promise((r) => setTimeout(r, opts.rereadDelayMs));
      if (opts.rereadStatus) {
        return HttpResponse.json(
          { object: "error", status: opts.rereadStatus, code: "object_not_found", message: "gone" },
          { status: opts.rereadStatus },
        );
      }
      return HttpResponse.json(notionPage(opts.name, opts.url === undefined ? X_STORED : opts.url));
    }),
    http.patch(PAGE_URL, async ({ request }) => {
      await record(request);
      if (opts.patchStatus) {
        return HttpResponse.json(
          { object: "error", status: opts.patchStatus, code: "service_unavailable", message: "down" },
          { status: opts.patchStatus },
        );
      }
      return HttpResponse.json(notionPage("whatever"));
    }),
  );
}

const esc = (html: string) => JSON.stringify(html).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

function xOembed(paragraph: string, url = X_CANONICAL) {
  const html = `<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">${paragraph}</p>&mdash; Naval (@naval) <a href="https://twitter.com/naval/status/${X_ID}">May 31, 2018</a></blockquote>\n`;
  return `{"url":"${url}","author_name":"Naval","author_url":"https://twitter.com/naval","html":${esc(html)},"type":"rich","version":"1.0"}`;
}

function mockOembed(record: Record_, body: string) {
  network.use(
    http.get(OEMBED, async ({ request }) => {
      await record(request);
      return new HttpResponse(body, { headers: { "content-type": "application/json; charset=utf-8" } });
    }),
  );
}

function htmlPage(url: string, record: Record_, html: string) {
  network.use(
    http.get(url, async ({ request }) => {
      await record(request);
      return new HttpResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }),
  );
}

// Every log line enrich wrote, parsed.
function captureLogs() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  return () =>
    spy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

async function runInWaitUntil(job: EnrichJob) {
  const ctx = createExecutionContext();
  ctx.waitUntil(enrich(job, env));
  await waitOnExecutionContext(ctx);
}

const xJob = (over: Partial<EnrichJob> = {}): EnrichJob => ({
  pageId: PAGE_ID,
  storedUrl: X_STORED,
  kind: "x",
  fallbackTitle: `X post ${X_ID}`,
  ...over,
});

const ARTICLE = "https://example.com/post/hello-world";
const pageJob = (over: Partial<EnrichJob> = {}): EnrichJob => ({
  pageId: PAGE_ID,
  storedUrl: ARTICLE,
  kind: "page",
  fallbackTitle: "Hello world · example.com",
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enrich: X job through waitUntil (criterion 1)", () => {
  it("patches Name with the looked-up title and URL with oEmbed's canonical, once", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("How to Get Rich (without getting lucky):"));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.map((s) => `${s.method} ${new URL(s.url).origin}${new URL(s.url).pathname}`)).toEqual([
      `GET ${OEMBED}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    expect(seen[2]!.body).toEqual({
      properties: {
        [PROPS.name]: { title: [{ text: { content: "Naval: How to Get Rich (without getting lucky):" } }] },
        [PROPS.url]: { url: X_CANONICAL },
      },
    });
    const lines = logs();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "enrich", ok: true, pageId: PAGE_ID, source: "x-oembed", patched: true });
    expect(typeof lines[0]!.ms).toBe("number");
  });

  it("collapses the newlines X's <br> leaves into single spaces", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("Line one<br><br>  Line two<br>Line three"));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    const patch = seen.find((s) => s.method === "PATCH")!;
    expect(patch.body).toMatchObject({
      properties: { [PROPS.name]: { title: [{ text: { content: "Naval: Line one Line two Line three" } }] } },
    });
  });

  it("a media-only post writes no Name but still swaps the URL (R2)", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed('<a href="https://t.co/AbC123">pic.twitter.com/AbC123</a>'));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    const patch = seen.find((s) => s.method === "PATCH")!;
    expect(patch.body).toEqual({ properties: { [PROPS.url]: { url: X_CANONICAL } } });
    expect(logs()[0]).toMatchObject({ event: "enrich", ok: true, patched: true });
  });

  it("no URL in the patch when oEmbed's url equals the stored URL (R5)", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("Same url", X_STORED));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    const patch = seen.find((s) => s.method === "PATCH")!;
    expect(patch.body).toEqual({
      properties: { [PROPS.name]: { title: [{ text: { content: "Naval: Same url" } }] } },
    });
  });
});

describe("enrich: Name guard (criterion 2)", () => {
  it("a row renamed since create gets no Name in the patch (URL still swapped)", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("How to Get Rich (without getting lucky):"));
    mockNotion(record, { name: "My own name for this" });

    await runInWaitUntil(xJob());

    const patch = seen.find((s) => s.method === "PATCH")!;
    expect(patch.body).toEqual({ properties: { [PROPS.url]: { url: X_CANONICAL } } });
    expect(logs()[0]).toMatchObject({ event: "enrich", ok: true, patched: true });
  });

  it("a renamed page row has nothing to write: re-read, no PATCH, patched false (R3)", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, "<html><head><title>Hello World, Properly</title></head><body></body></html>");
    mockNotion(record, { name: "Edited in Notion" });

    await runInWaitUntil(pageJob());

    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    expect(seen[1]!.url).toBe(PAGE_URL);
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, pageId: PAGE_ID, source: "page", patched: false }),
    ]);
  });

  it("an unchanged Name (whitespace aside) is replaced by the page title", async () => {
    captureLogs();
    const { seen, record } = recorder();
    htmlPage(
      ARTICLE,
      record,
      "<html><head><title>\n  Hello World,\n Properly  </title></head><body></body></html>",
    );
    mockNotion(record, { name: "  Hello world · example.com " });

    await runInWaitUntil(pageJob());

    expect(seen[0]!.userAgent).toBe(PAGE_UA);
    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { [PROPS.name]: { title: [{ text: { content: "Hello World, Properly" } }] } },
    });
  });

});

describe("enrich: URL guard and URL failures (PR 17 rulings)", () => {
  it("a URL edited in Notion since create is left alone; the Name is still written", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("How to Get Rich (without getting lucky):"));
    mockNotion(record, { name: `X post ${X_ID}`, url: "https://example.com/my-own-url" });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: {
        [PROPS.name]: { title: [{ text: { content: "Naval: How to Get Rich (without getting lucky):" } }] },
      },
    });
    expect(logs()[0]).toMatchObject({ event: "enrich", ok: true, patched: true });
  });

  it("a URL emptied in Notion since create is left alone too", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed('<a href="https://t.co/AbC123">pic.twitter.com/AbC123</a>'));
    mockNotion(record, { name: `X post ${X_ID}`, url: null });

    await runInWaitUntil(xJob());

    // Media-only post (no Name) and an edited URL: nothing to write.
    expect(seen.some((s) => s.method === "PATCH")).toBe(false);
    expect(logs()).toEqual([expect.objectContaining({ event: "enrich", ok: true, patched: false })]);
  });

  it("a too-long oEmbed url (url_too_long) drops only the URL, never the Name", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    const long = `https://x.com/naval/status/${X_ID}?pad=${"a".repeat(2100)}`;
    mockOembed(record, xOembed("How to Get Rich (without getting lucky):", long));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: {
        [PROPS.name]: { title: [{ text: { content: "Naval: How to Get Rich (without getting lucky):" } }] },
      },
    });
    expect(logs()).toEqual([expect.objectContaining({ event: "enrich", ok: true, patched: true })]);
  });
});

describe("enrich: a >2000-char created title isn't read as an edit (PR 14 carry)", () => {
  it("nameUnchanged compares a long client title truncated, as titleProp wrote it", () => {
    const long = "Long client title ".repeat(150).trim(); // 2699 chars
    const written = long.slice(0, 2000);
    const job = pageJob({ clientTitle: long });
    expect(nameUnchanged(job, written)).toBe(true);
    expect(nameUnchanged(job, `${written} `)).toBe(true);
    expect(nameUnchanged(job, "Something the user typed")).toBe(false);
    expect(nameUnchanged(job, null)).toBe(false);
  });

  it("a row created with a 2599-char title (Name holds 2000) still gets the looked-up title", async () => {
    captureLogs();
    const { seen, record } = recorder();
    const long = "word ".repeat(520).trim(); // 2599 chars
    htmlPage(ARTICLE, record, "<html><head><title>The Real Title</title></head></html>");
    mockNotion(record, { name: long.slice(0, 2000) });

    await runInWaitUntil(pageJob({ fallbackTitle: long }));

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { [PROPS.name]: { title: [{ text: { content: "The Real Title" } }] } },
    });
  });
});

describe("enrich: review fixes (PR 17 round 2)", () => {
  it("a real post ending in a colon before an image keeps its title", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(
      record,
      xOembed('The three big decisions in life: <a href="https://t.co/AbC123">pic.twitter.com/abc</a>'),
    );
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: {
        [PROPS.name]: {
          title: [{ text: { content: "Naval: The three big decisions in life: pic.twitter.com/abc" } }],
        },
        [PROPS.url]: { url: X_CANONICAL },
      },
    });
  });

  it("Twitterbot: a description that's only a t.co link is media-only, so no Name", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    network.use(
      http.get(OEMBED, async ({ request }) => {
        await record(request);
        return new HttpResponse("<html><head><title>Nothing to see here</title></head></html>", {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }),
    );
    htmlPage(
      X_STORED,
      record,
      '<html><head><meta property="og:title" content="Naval (@naval) on X"/>' +
        '<meta property="og:description" content="https://t.co/AbC123"/></head><body></body></html>',
    );
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.map((s) => `${s.method} ${new URL(s.url).host}`)).toEqual([
      "GET publish.x.com",
      "GET x.com",
      "GET api.notion.com",
    ]);
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, source: "x-twitterbot", patched: false }),
    ]);
  });

  it("an oEmbed url naming a different post id is not swapped in", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("Hello", "https://x.com/naval/status/999"));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { [PROPS.name]: { title: [{ text: { content: "Naval: Hello" } }] } },
    });
  });

  it("an oEmbed url whose id only starts with the job's id is not swapped in", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("Hello", `https://x.com/naval/status/${X_ID}7`));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { [PROPS.name]: { title: [{ text: { content: "Naval: Hello" } }] } },
    });
  });

  it("an oEmbed url with the job's id and a query string is swapped in", async () => {
    captureLogs();
    const { seen, record } = recorder();
    const url = `https://x.com/naval/status/${X_ID}?s=20`;
    mockOembed(record, xOembed("Hello", url));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toMatchObject({
      properties: { [PROPS.url]: { url } },
    });
  });
});

describe("enrich: R2 title hygiene", () => {
  it("a page title equal to the stored URL is no title: patch skipped", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, `<html><head><title>${ARTICLE}/</title></head></html>`);
    mockNotion(record, { name: "Hello world · example.com" });

    await runInWaitUntil(pageJob());

    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    expect(logs()[0]).toMatchObject({ event: "enrich", source: "page", patched: false });
  });

  it("a 3000-char title is truncated to 2000 in the patch body", async () => {
    captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, `<html><head><title>${"a".repeat(3000)}</title></head></html>`);
    mockNotion(record, { name: "Hello world · example.com" });

    await runInWaitUntil(pageJob());

    const body = seen.find((s) => s.method === "PATCH")!.body as {
      properties: Record<string, { title: { text: { content: string } }[] }>;
    };
    expect(body.properties[PROPS.name]!.title[0]!.text.content).toBe("a".repeat(2000));
  });
});

describe("enrich: lookup stage timeout (criterion 3)", () => {
  // Real wait: AbortSignal.timeout runs on workerd's clock, which fake timers don't drive.
  it("a hanging page fetch ends the stage at about 5 s; the re-read still runs", { timeout: 15_000 }, async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    network.use(
      http.get(ARTICLE, async ({ request }) => {
        await record(request);
        return new Promise<Response>(() => {});
      }),
    );
    // The re-read takes 300 ms of its own; a signal shared with the expired lookup would
    // abort it and log enrich_failed instead.
    mockNotion(record, { name: "Hello world · example.com", rereadDelayMs: 300 });

    const start = performance.now();
    await runInWaitUntil(pageJob());
    const elapsed = performance.now() - start;

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${ARTICLE}`, `GET ${PAGE_URL}`]);
    // The re-read starts once the stage gives up (4 s fetch timeout or the 5 s stage cap).
    expect(seen[1]!.at).toBeGreaterThanOrEqual(3900);
    expect(seen[1]!.at).toBeLessThan(5500);
    expect(elapsed).toBeLessThan(6500);
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, source: "fallback", patched: false }),
    ]);
  });

  it("an X lookup hanging on both fetches is cut at 5 s, not 8 s", { timeout: 15_000 }, async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    network.use(
      http.get(OEMBED, async ({ request }) => {
        await record(request);
        return new Promise<Response>(() => {});
      }),
      http.get(X_STORED, async ({ request }) => {
        await record(request);
        return new Promise<Response>(() => {});
      }),
    );
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    const reread = seen.find((s) => s.url === PAGE_URL)!;
    expect(reread.at).toBeGreaterThanOrEqual(4900);
    expect(reread.at).toBeLessThan(5800);
    expect(seen.some((s) => s.method === "PATCH")).toBe(false);
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, source: "fallback", patched: false }),
    ]);
  });
});

describe("enrich: Notion failures (criterion 4)", () => {
  it("a 503 on the patch logs enrich_failed {stage: patch} and nothing escapes waitUntil", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("How to Get Rich (without getting lucky):"));
    mockNotion(record, { name: `X post ${X_ID}`, patchStatus: 503 });

    await expect(runInWaitUntil(xJob())).resolves.toBeUndefined();

    expect(seen.filter((s) => s.method === "PATCH")).toHaveLength(1); // no retry
    expect(logs()).toEqual([
      {
        event: "enrich_failed",
        ok: false,
        stage: "patch",
        pageId: PAGE_ID,
        status: 503,
        error: "service_unavailable",
      },
    ]);
  });

  it("a failed re-read logs enrich_failed {stage: reread} and never patches", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("How to Get Rich (without getting lucky):"));
    mockNotion(record, { name: `X post ${X_ID}`, rereadStatus: 404 });

    await expect(enrich(xJob(), env)).resolves.toBeUndefined();

    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich_failed", stage: "reread", status: 404, error: "object_not_found" }),
    ]);
  });

  it("an unexpected error logs enrich_failed {stage: unexpected} and doesn't throw", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, "<html><head><title>A Real Title</title></head></html>");
    mockNotion(record, { name: "Hello world · example.com" });
    // A malformed job (non-string fallbackTitle) makes the Name guard throw a TypeError.
    const job = pageJob({ fallbackTitle: 42 as unknown as string });

    await expect(runInWaitUntil(job)).resolves.toBeUndefined();

    expect(seen.some((s) => s.method === "PATCH")).toBe(false);
    expect(logs()).toEqual([
      { event: "enrich_failed", ok: false, stage: "unexpected", pageId: PAGE_ID, error: "TypeError" },
    ]);
  });
});

describe("enrich: client title (criterion 5)", () => {
  it("no lookup fetch happens; the first request is the re-read", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    // Lookup handlers that would record if hit.
    mockOembed(record, xOembed("Should never be read"));
    htmlPage(X_STORED, record, "<html><head><title>nope</title></head></html>");
    mockNotion(record, { name: "Client title" });

    await runInWaitUntil(xJob({ clientTitle: "Client title" }));

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${PAGE_URL}`]);
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, pageId: PAGE_ID, source: "client", patched: false }),
    ]);
  });
});

describe("lookupTitle dispatch", () => {
  const signal = () => AbortSignal.timeout(5000);

  it("media: a null from oEmbed falls through to the page read (R1, TikTok)", async () => {
    const { seen, record } = recorder();
    const tiktok = "https://www.tiktok.com/@scout2015/video/6718335390845095173";
    network.use(
      http.get("https://www.tiktok.com/oembed", async ({ request }) => {
        await record(request);
        return HttpResponse.json({ version: "1.0", type: "video", author_name: "Scout" });
      }),
    );
    htmlPage(
      tiktok,
      record,
      '<html><head><meta property="og:title" content="TikTok · Scout"></head></html>',
    );

    const result = await lookupTitle(tiktok, "media", signal());

    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/oembed", "/@scout2015/video/6718335390845095173"]);
    expect(seen[1]!.userAgent).toBe(PAGE_UA);
    expect(result).toMatchObject({ title: "TikTok · Scout", source: "page" });
  });

  it("media: an oEmbed title is used without reading the page", async () => {
    const { seen, record } = recorder();
    network.use(
      http.get("https://www.youtube.com/oembed", async ({ request }) => {
        await record(request);
        return HttpResponse.json({ title: "Never Gonna Give You Up" });
      }),
    );

    const result = await lookupTitle("https://youtube.com/watch?v=dQw4w9WgXcQ", "media", signal());

    expect(seen).toHaveLength(1);
    expect(result).toMatchObject({ title: "Never Gonna Give You Up", source: "media-oembed" });
  });

  it("x: the post id comes from the stored URL", async () => {
    const { seen, record } = recorder();
    mockOembed(record, xOembed("Hi"));

    const result = await lookupTitle(X_STORED, "x", signal());

    expect(new URL(seen[0]!.url).searchParams.get("url")).toBe(X_STORED);
    expect(result).toMatchObject({ title: "Naval: Hi", url: X_CANONICAL, author: "Naval", source: "x-oembed" });
  });

  it("returns at the stage signal even when a fetch ignores its abort", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      calls += 1;
      return new Promise<Response>(() => {});
    });
    const start = performance.now();

    const result = await lookupTitle(ARTICLE, "page", AbortSignal.timeout(200));

    expect(calls).toBe(1);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result).toEqual({ title: null, source: "fallback", bytesRead: 0 });
  });

  it("every failure is a fallback result, never a throw", async () => {
    // The catch-all fails every request here.
    expect(await lookupTitle(ARTICLE, "page", signal())).toEqual({ title: null, source: "fallback", bytesRead: 0 });
    expect(await lookupTitle(X_STORED, "x", signal())).toEqual({ title: null, source: "fallback", bytesRead: 0 });
    expect(await lookupTitle("https://x.com/naval", "x", signal())).toEqual({
      title: null,
      source: "fallback",
      bytesRead: 0,
    });
    const aborted = AbortSignal.abort();
    expect(await lookupTitle(ARTICLE, "page", aborted)).toEqual({ title: null, source: "fallback", bytesRead: 0 });
  });
});
