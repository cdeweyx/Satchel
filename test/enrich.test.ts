/// <reference types="vite/client" />
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROPS } from "../src/config";
import type { EnrichJob } from "../src/contract";
import { DEADLINE_MS, enrich, nameUnchanged, toClaudeInput } from "../src/enrich";
import worker from "../src/index";
import { invalidateTagCache } from "../src/tags";
import { lookupTitle } from "../src/title";
import { PAGE_UA } from "../src/title/page";
import articleText from "./fixtures/x-article.json?raw";
import { network } from "./network";

const API = "https://api.notion.com/v1";
const PAGE_ID = "11111111-2222-3333-4444-555555555555";
const PAGE_URL = `${API}/pages/${PAGE_ID}`;
const DS = "test-data-source-id"; // vitest.config.ts binding
const SCHEMA_URL = `${API}/data_sources/${DS}`;
const MESSAGES = "https://api.anthropic.com/v1/messages";

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
// `tags` adds a Tags multi_select with those options (omitted: no Tags property at all).
function notionPage(name: string, url: string | null = X_STORED, tags?: { id: string; name: string }[]) {
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
      ...(tags ? { [PROPS.tags]: { id: "t", type: "multi_select", multi_select: tags } } : {}),
    },
  };
}

type NotionFailure = { status: number; code: string };

// Mocks the re-read (GET) and the patch (PATCH) of PAGE_ID, recording both. `patchFailures`
// answers the Nth patch with its entry (null or past the end: 200).
function mockNotion(
  record: Record_,
  opts: {
    name: string | (() => string);
    url?: string | null;
    tags?: { id: string; name: string }[];
    rereadStatus?: number;
    patchStatus?: number;
    patchFailures?: (NotionFailure | null)[];
    rereadDelayMs?: number;
    patchDelayMs?: number;
  },
) {
  let patches = 0;
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
      const name = typeof opts.name === "function" ? opts.name() : opts.name;
      return HttpResponse.json(notionPage(name, opts.url === undefined ? X_STORED : opts.url, opts.tags));
    }),
    http.patch(PAGE_URL, async ({ request }) => {
      await record(request);
      if (opts.patchDelayMs) await new Promise((r) => setTimeout(r, opts.patchDelayMs));
      const failure = opts.patchFailures?.[patches++];
      if (failure) {
        return HttpResponse.json(
          { object: "error", status: failure.status, code: failure.code, message: "mocked" },
          { status: failure.status },
        );
      }
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

async function runInWaitUntil(job: EnrichJob, opts?: { deadlineMs?: number }) {
  const ctx = createExecutionContext();
  ctx.waitUntil(opts ? enrich(job, env, opts) : enrich(job, env));
  await waitOnExecutionContext(ctx);
}

// --- Tag options (data source schema) and Claude ---

type TagOption = { id: string; name: string; color?: string };
const OPTIONS: TagOption[] = [
  { id: "opt-ai", name: "AI", color: "blue" },
  { id: "opt-design", name: "Design", color: "red" },
  { id: "opt-news", name: "News", color: "green" },
  { id: "opt-product", name: "Product", color: "gray" },
];

function schemaBody(options: TagOption[]) {
  return {
    object: "data_source",
    id: DS,
    properties: {
      [PROPS.name]: { id: "title", name: PROPS.name, type: "title", title: {} },
      [PROPS.tags]: { id: "t", name: PROPS.tags, type: "multi_select", multi_select: { options } },
    },
  };
}

// Serves each schema retrieve in turn (the last one repeats): an options list or a failure.
function mockSchema(record: Record_, ...answers: (TagOption[] | NotionFailure)[]) {
  let calls = 0;
  network.use(
    http.get(SCHEMA_URL, async ({ request }) => {
      await record(request);
      const answer = answers[Math.min(calls++, answers.length - 1)]!;
      if (!Array.isArray(answer)) {
        return HttpResponse.json(
          { object: "error", status: answer.status, code: answer.code, message: "mocked" },
          { status: answer.status },
        );
      }
      return HttpResponse.json(schemaBody(answer));
    }),
  );
}

// A Messages API answer, as research 02 recorded it.
function claudeAnswer(output: { title: string; tags: string[] }) {
  return HttpResponse.json(
    {
      id: "msg_01Test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify(output) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 900, output_tokens: 40 },
    },
    { headers: { "request-id": "req_ok_1" } },
  );
}

function claude401() {
  return HttpResponse.json(
    { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_401" },
    { status: 401, headers: { "request-id": "req_401" } },
  );
}

type ClaudeBody = {
  system: string;
  messages: { role: string; content: string }[];
  output_config: { format: { schema: { properties: { tags: { items: { enum: string[] } } } } } };
};

function mockClaude(record: Record_, answer: () => Response | Promise<Response>) {
  network.use(
    http.post(MESSAGES, async ({ request }) => {
      await record(request);
      return answer();
    }),
  );
}

const tagsOf = (body: unknown) =>
  (body as { properties: Record<string, { multi_select?: unknown }> }).properties[PROPS.tags]?.multi_select;

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

// The tag cache is per isolate, so every test starts cold. The default schema has a Tags
// property with no options, so Claude is skipped (R4) and the SAT-12 tests below keep
// exercising lookup, guards and failures on their own. SAT-15 tests mock their own schema.
beforeEach(() => {
  invalidateTagCache();
  network.use(http.get(SCHEMA_URL, () => HttpResponse.json(schemaBody([]))));
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
        [PROPS.name]: { title: [{ text: { content: "How to Get Rich (without getting lucky):" } }] },
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
      properties: { [PROPS.name]: { title: [{ text: { content: "Line one Line two Line three" } }] } },
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
      properties: { [PROPS.name]: { title: [{ text: { content: "Same url" } }] } },
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
        [PROPS.name]: { title: [{ text: { content: "How to Get Rich (without getting lucky):" } }] },
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
        [PROPS.name]: { title: [{ text: { content: "How to Get Rich (without getting lucky):" } }] },
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
          title: [{ text: { content: "The three big decisions in life: pic.twitter.com/abc" } }],
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
      properties: { [PROPS.name]: { title: [{ text: { content: "Hello" } }] } },
    });
  });

  it("an oEmbed url whose id only starts with the job's id is not swapped in", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("Hello", `https://x.com/naval/status/${X_ID}7`));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { [PROPS.name]: { title: [{ text: { content: "Hello" } }] } },
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

// --- SAT-15: Claude stage, tag guard, 22 s deadline ---

const PAGE_HTML = "<html><head><title>Hello World, Properly</title></head><body></body></html>";
const LOOKED_UP = { [PROPS.name]: { title: [{ text: { content: "Hello World, Properly" } }] } };
const nameProp = (s: string) => ({ [PROPS.name]: { title: [{ text: { content: s } }] } });

describe("SAT-15 criterion 1: tag guard in the patch", () => {
  it("a fake tag is dropped, at most 3 survive, and Tags go out as ids only", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, () =>
      claudeAnswer({ title: "Hello World, Properly Cleaned", tags: ["AI", "Made Up Tag", "design", "News", "Product"] }),
    );
    mockNotion(record, { name: "Hello world · example.com", tags: [] });

    await runInWaitUntil(pageJob());

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `GET ${ARTICLE}`,
      `GET ${SCHEMA_URL}`,
      `POST ${MESSAGES}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    // The enum is the live option names, in schema order.
    const claudeBody = seen[2]!.body as ClaudeBody;
    expect(claudeBody.output_config.format.schema.properties.tags.items.enum).toEqual([
      "AI",
      "Design",
      "News",
      "Product",
    ]);
    expect(claudeBody.messages[0]!.content).toBe("Title: Hello World, Properly\nURL: https://example.com/post/hello-world");
    // "Made Up Tag" is gone, "design" matched case-insensitively, capped at 3, ids only.
    expect(seen[4]!.body).toEqual({
      properties: {
        ...nameProp("Hello World, Properly Cleaned"),
        [PROPS.tags]: { multi_select: [{ id: "opt-ai" }, { id: "opt-design" }, { id: "opt-news" }] },
      },
    });
    expect(JSON.stringify(seen[4]!.body)).not.toContain('"name"');
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, pageId: PAGE_ID, source: "page", claude: true, tags: 3 }),
    ]);
  });

  it("Claude's title gets R2 hygiene: whitespace collapsed; blank falls back to the looked-up title", async () => {
    captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "  Spaced\n\n  Out   Title ", tags: ["AI"] }));
    mockNotion(record, { name: "Hello world · example.com", tags: [] });

    await runInWaitUntil(pageJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { ...nameProp("Spaced Out Title"), [PROPS.tags]: { multi_select: [{ id: "opt-ai" }] } },
    });
  });

  it("an empty options list skips Claude entirely and logs claude: false (R4)", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, []);
    mockClaude(record, () => claudeAnswer({ title: "Never", tags: [] }));
    mockNotion(record, { name: "Hello world · example.com", tags: [] });

    await runInWaitUntil(pageJob());

    expect(seen.some((s) => s.url === MESSAGES)).toBe(false);
    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({ properties: LOOKED_UP });
    expect(logs()).toEqual([expect.objectContaining({ event: "enrich", ok: true, claude: false, tags: 0 })]);
  });
});

describe("SAT-15 criterion 2: Claude 401 through /save", () => {
  it("the save answers 200 first; the patch carries the looked-up title and no Tags", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    network.use(
      http.post(`${API}/data_sources/${DS}/query`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ object: "list", results: [], has_more: false });
      }),
      http.post(`${API}/pages`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ object: "page", id: PAGE_ID, properties: {} });
      }),
    );
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return claude401();
    });
    // The re-read shows whatever the create wrote, as Notion would.
    const created = () => {
      const body = seen.find((s) => s.method === "POST" && s.url === `${API}/pages`)!.body as {
        properties: Record<string, { title: { text: { content: string } }[] }>;
      };
      return body.properties[PROPS.name]!.title[0]!.text.content;
    };
    mockNotion(record, { name: created, tags: [] });

    const ctx = createExecutionContext();
    let requestsBeforeResponse = -1;
    const res = await worker
      .fetch(
        new Request("https://satchel.test/save", {
          method: "POST",
          headers: { "x-satchel-key": "test-satchel-key", "content-type": "application/json" },
          body: JSON.stringify({ url: ARTICLE, status: "later" }),
        }) as Request<unknown, IncomingRequestCfProperties>,
        env,
        ctx,
      )
      .then((r) => {
        requestsBeforeResponse = seen.length;
        return r;
      });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: PAGE_ID });
    await waitOnExecutionContext(ctx);

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `POST ${API}/data_sources/${DS}/query`,
      `POST ${API}/pages`,
      `GET ${ARTICLE}`,
      `GET ${SCHEMA_URL}`,
      `POST ${MESSAGES}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    // The 200 was back while only the query and create had happened.
    expect(requestsBeforeResponse).toBe(2);
    expect(seen[6]!.body).toEqual({ properties: LOOKED_UP });
    const lines = logs();
    expect(lines).toContainEqual({ event: "claude_failed", class: "AuthenticationError", status: 401, requestId: "req_401" });
    expect(lines.filter((l) => l.event === "enrich")).toEqual([
      expect.objectContaining({ ok: true, pageId: PAGE_ID, source: "page", patched: true, claude: false, tags: 0 }),
    ]);
    expect(lines.some((l) => l.event === "enrich_failed")).toBe(false);
  });
});

describe("SAT-15 criterion 3: a pre-tagged row", () => {
  it("re-read shows tags: the patch has no Tags key, the Name still lands", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "Claude Title", tags: ["AI", "Design"] }));
    mockNotion(record, { name: "Hello world · example.com", tags: [{ id: "opt-news", name: "News" }] });

    await runInWaitUntil(pageJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({ properties: nameProp("Claude Title") });
    expect(logs()).toEqual([expect.objectContaining({ event: "enrich", ok: true, claude: true, tags: 0 })]);
  });

  it("a re-read without a readable Tags property is treated as tagged (never overwrite what we can't read)", async () => {
    captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "Claude Title", tags: ["AI"] }));
    mockNotion(record, { name: "Hello world · example.com" }); // no Tags property

    await runInWaitUntil(pageJob());

    expect(tagsOf(seen.find((s) => s.method === "PATCH")!.body)).toBeUndefined();
  });
});

describe("SAT-15 criterion 4: stale tag cache", () => {
  it("patch 400 validation_error → one schema refetch, one more patch with the new ids", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    // "AI" was recreated under a new id and "Design" deleted since the cache filled.
    mockSchema(record, OPTIONS, [
      { id: "opt-ai-v2", name: "AI" },
      { id: "opt-news", name: "News" },
    ]);
    mockClaude(record, () => claudeAnswer({ title: "Claude Title", tags: ["AI", "Design"] }));
    mockNotion(record, {
      name: "Hello world · example.com",
      tags: [],
      patchFailures: [{ status: 400, code: "validation_error" }],
    });

    await runInWaitUntil(pageJob());

    expect(seen.map((s) => `${s.method} ${s.url}`).slice(3)).toEqual([
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
      `GET ${SCHEMA_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    const patches = seen.filter((s) => s.method === "PATCH");
    expect(patches[0]!.body).toEqual({
      properties: { ...nameProp("Claude Title"), [PROPS.tags]: { multi_select: [{ id: "opt-ai" }, { id: "opt-design" }] } },
    });
    expect(patches[1]!.body).toEqual({
      properties: { ...nameProp("Claude Title"), [PROPS.tags]: { multi_select: [{ id: "opt-ai-v2" }] } },
    });
    expect(logs()).toEqual([expect.objectContaining({ event: "enrich", ok: true, claude: true, tags: 1 })]);
  });

  it("a second validation_error is enrich_failed {stage: patch}; no third patch", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "Claude Title", tags: ["AI"] }));
    const bad = { status: 400, code: "validation_error" };
    mockNotion(record, { name: "Hello world · example.com", tags: [], patchFailures: [bad, bad, bad] });

    await runInWaitUntil(pageJob());

    expect(seen.filter((s) => s.method === "PATCH")).toHaveLength(2);
    expect(seen.filter((s) => s.url === SCHEMA_URL)).toHaveLength(2);
    expect(logs()).toEqual([
      { event: "enrich_failed", ok: false, stage: "patch", pageId: PAGE_ID, status: 400, error: "validation_error" },
    ]);
  });

  it("a validation_error on a patch without Tags is enrich_failed {stage: patch}, no refetch (R5)", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "Claude Title", tags: ["AI"] }));
    mockNotion(record, {
      name: "Hello world · example.com",
      tags: [{ id: "opt-ai", name: "AI" }],
      patchFailures: [{ status: 400, code: "validation_error" }],
    });

    await runInWaitUntil(pageJob());

    expect(seen.filter((s) => s.method === "PATCH")).toHaveLength(1);
    expect(seen.filter((s) => s.url === SCHEMA_URL)).toHaveLength(1);
    expect(logs()).toEqual([
      { event: "enrich_failed", ok: false, stage: "patch", pageId: PAGE_ID, status: 400, error: "validation_error" },
    ]);
  });

  it("a failed refetch is enrich_failed {stage: schema}; no second patch", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, OPTIONS, { status: 503, code: "service_unavailable" });
    mockClaude(record, () => claudeAnswer({ title: "Claude Title", tags: ["AI"] }));
    mockNotion(record, {
      name: "Hello world · example.com",
      tags: [],
      patchFailures: [{ status: 400, code: "validation_error" }],
    });

    await runInWaitUntil(pageJob());

    expect(seen.filter((s) => s.method === "PATCH")).toHaveLength(1);
    expect(logs()).toEqual([
      { event: "enrich_failed", ok: false, stage: "schema", pageId: PAGE_ID, status: 503, error: "service_unavailable" },
    ]);
  });
});

describe("SAT-15 criterion 5: the 22 s deadline", () => {
  it("Claude hanging past the deadline: enrich_deadline, then re-read and patch on their own timeouts", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, () => new Promise<Response>(() => {}));
    // Each takes 200 ms; under the already-fired deadline signal they'd abort at once.
    mockNotion(record, { name: "Hello world · example.com", tags: [], rereadDelayMs: 200, patchDelayMs: 200 });

    const start = performance.now();
    await runInWaitUntil(pageJob(), { deadlineMs: 300 });
    const elapsed = performance.now() - start;

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${ARTICLE}`,
      `GET ${SCHEMA_URL}`,
      `POST ${MESSAGES}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    const reread = seen[3]!;
    expect(reread.at).toBeGreaterThanOrEqual(290);
    expect(reread.at).toBeLessThan(800);
    // About deadline + re-read + patch (300 + 200 + 200), nowhere near Claude's 10 s.
    expect(elapsed).toBeGreaterThanOrEqual(680);
    expect(elapsed).toBeLessThan(2000);
    expect(seen[4]!.body).toEqual({ properties: LOOKED_UP });
    const lines = logs();
    const deadline = lines.find((l) => l.event === "enrich_deadline");
    expect(deadline).toMatchObject({ pageId: PAGE_ID });
    expect(deadline!.ms as number).toBeGreaterThanOrEqual(290);
    expect(lines.filter((l) => l.event === "enrich")).toEqual([
      expect.objectContaining({ ok: true, patched: true, claude: false, tags: 0 }),
    ]);
    expect(lines.some((l) => l.event === "enrich_failed")).toBe(false);
  });

  it("the default deadline is 22 s from task start", async () => {
    expect(DEADLINE_MS).toBe(22_000);
    captureLogs();
    const timers = vi.spyOn(globalThis, "setTimeout");
    // Everything fails fast against the catch-all; only the timer matters here.
    await enrich(pageJob(), env);
    expect(timers.mock.calls.some((c) => c[1] === 22_000)).toBe(true);
    timers.mockClear();
    await enrich(pageJob(), env, { deadlineMs: 300 });
    expect(timers.mock.calls.some((c) => c[1] === 300)).toBe(true);
    expect(timers.mock.calls.some((c) => c[1] === 22_000)).toBe(false);
  });
});

describe("SAT-15 criterion 6: schema retrieve fails", () => {
  it("503 → no Claude call, the patch carries the looked-up title and no Tags, enrich_failed {stage: schema}", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, PAGE_HTML);
    mockSchema(record, { status: 503, code: "service_unavailable" });
    mockClaude(record, () => claudeAnswer({ title: "Never", tags: ["AI"] }));
    mockNotion(record, { name: "Hello world · example.com", tags: [] });

    await runInWaitUntil(pageJob());

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${ARTICLE}`,
      `GET ${SCHEMA_URL}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    expect(seen[3]!.body).toEqual({ properties: LOOKED_UP });
    expect(logs()).toEqual([
      { event: "enrich_failed", ok: false, stage: "schema", pageId: PAGE_ID, status: 503, error: "service_unavailable" },
      expect.objectContaining({ event: "enrich", ok: true, patched: true, claude: false, tags: 0 }),
    ]);
  });
});

describe("SAT-15: a client title is cleaned by Claude too (R3)", () => {
  it("Claude gets the client title and URL only; its title replaces an unedited client title", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "How to Get Rich", tags: ["AI"] }));
    mockNotion(record, { name: "how to get rich | Medium", tags: [] });

    await runInWaitUntil(pageJob({ clientTitle: "how to get rich | Medium" }));

    const claudeBody = seen.find((s) => s.url === MESSAGES)!.body as ClaudeBody;
    expect(claudeBody.messages).toEqual([
      { role: "user", content: "Title: how to get rich | Medium\nURL: https://example.com/post/hello-world" },
    ]);
    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { ...nameProp("How to Get Rich"), [PROPS.tags]: { multi_select: [{ id: "opt-ai" }] } },
    });
  });

  it("a client title edited in Notion since create keeps the user's edit; Tags still land", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "How to Get Rich", tags: ["AI"] }));
    mockNotion(record, { name: "My own words", tags: [] });

    await runInWaitUntil(pageJob({ clientTitle: "how to get rich | Medium" }));

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { [PROPS.tags]: { multi_select: [{ id: "opt-ai" }] } },
    });
  });
});

describe("SAT-15 criterion 7: toClaudeInput shapes", () => {
  it("x: an X lookup with author and text", () => {
    const lookup = {
      title: "Naval: How to Get Rich (without getting lucky):",
      description: "How to Get Rich\n(without getting lucky):",
      author: "Naval",
      handle: "naval",
      url: X_CANONICAL,
      source: "x-oembed" as const,
      bytesRead: 400,
    };
    expect(toClaudeInput(xJob(), lookup)).toEqual({
      shape: "x",
      author: "Naval",
      handle: "naval",
      text: "How to Get Rich (without getting lucky):",
      url: "https://x.com/i/status/1002103360646823936",
    });
  });

  it("titled: a looked-up page title, cleaned, with its description", () => {
    const lookup = {
      title: "  Hello World,\n Properly ",
      description: "A post about saying hello.",
      source: "page" as const,
      bytesRead: 900,
    };
    expect(toClaudeInput(pageJob(), lookup)).toEqual({
      shape: "titled",
      title: "Hello World, Properly",
      description: "A post about saying hello.",
      url: "https://example.com/post/hello-world",
    });
  });

  it("titled: a client title skips lookup, so no description, just the title and URL", () => {
    const lookup = { title: null, source: "client" as const, bytesRead: 0 };
    expect(toClaudeInput(pageJob({ clientTitle: "how to get rich | Medium" }), lookup)).toEqual({
      shape: "titled",
      title: "how to get rich | Medium",
      url: "https://example.com/post/hello-world",
    });
  });

  it("untitled: no usable title (none, or the URL itself), with or without a description", () => {
    expect(
      toClaudeInput(pageJob(), { title: null, description: "Only a description", source: "page", bytesRead: 10 }),
    ).toEqual({ shape: "untitled", description: "Only a description", url: "https://example.com/post/hello-world" });
    expect(toClaudeInput(pageJob(), { title: ARTICLE, source: "page", bytesRead: 10 })).toEqual({
      shape: "untitled",
      url: "https://example.com/post/hello-world",
    });
    expect(toClaudeInput(xJob(), { title: null, source: "fallback", bytesRead: 0 })).toEqual({
      shape: "untitled",
      url: "https://x.com/i/status/1002103360646823936",
    });
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

// SAT-37: a post whose text is only a link (Aaron Levie's x.com/levie/status/2048950940661932319)
// has no post text, like a media-only post. No Name from the lookup, and Claude is skipped.
describe("SAT-37 criterion 1: a link-only X post has no post text", () => {
  const twitterbotOnly = (record: Record_, description: string) => {
    network.use(
      http.get(OEMBED, async ({ request }) => {
        await record(request);
        return new HttpResponse("<html></html>", { status: 404, headers: { "content-type": "text/html" } });
      }),
    );
    htmlPage(
      X_STORED,
      record,
      '<html><head><meta property="og:title" content="Naval (@naval) on X"/>' +
        `<meta property="og:description" content="${description}"/></head><body></body></html>`,
    );
  };

  it.each([
    ["the t.co URL", '<a href="https://t.co/Lv1eB0x">https://t.co/Lv1eB0x</a>'],
    ["a display URL cut with an ellipsis", '<a href="https://t.co/Lv1eB0x">box.com/blog/ai-agents-a…</a>'],
    [
      "a display URL plus a pic.twitter.com link",
      '<a href="https://t.co/a">box.com/blog/x</a> <a href="https://t.co/b">pic.twitter.com/b</a>',
    ],
  ])("oEmbed: a <p> whose only text is %s writes no Name (URL still swapped)", async (_label, paragraph) => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed(paragraph));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { [PROPS.url]: { url: X_CANONICAL } },
    });
  });

  it.each([
    ["real text before the link", 'Worth a read: <a href="https://t.co/Lv1eB0x">box.com/blog/ai-agents</a>'],
    ["a word with a dot and an ellipsis but no path", "Node.js…"],
    ["a word with a dot", "Node.js"],
    ["a bare domain", "box.com"],
  ])("oEmbed: %s is post text, so it keeps its title", async (_label, paragraph) => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed(paragraph));
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    const text = paragraph.replace(/<[^>]*>/g, "");
    expect(seen.find((s) => s.method === "PATCH")!.body).toMatchObject({
      properties: nameProp(text),
    });
  });

  it("Twitterbot: a description that's only a non-t.co URL is no post text, so no Name", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    twitterbotOnly(record, "https://www.box.com/blog/ai-agents");
    mockNotion(record, { name: `X post ${X_ID}` });

    await runInWaitUntil(xJob());

    expect(seen.some((s) => s.method === "PATCH")).toBe(false);
    expect(logs()).toEqual([
      expect.objectContaining({
        event: "enrich",
        ok: true,
        source: "x-twitterbot",
        patched: false,
        claude: false,
        reason: "no_text_x",
      }),
    ]);
  });
});

describe("SAT-37 criteria 2 and 3 (fix round 1): Claude on a no-text X post", () => {
  it.each([
    ["link-only", '<a href="https://t.co/Lv1eB0x">https://t.co/Lv1eB0x</a>'],
    ["media-only", '<a href="https://t.co/AbC123">pic.twitter.com/AbC123</a>'],
  ])("%s, no client title: no schema read, no Anthropic request, no Name, no Tags", async (_label, paragraph) => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed(paragraph));
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "X Post", tags: ["AI"] }));
    mockNotion(record, { name: `X post ${X_ID}`, tags: [] });

    await runInWaitUntil(xJob());

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `GET ${OEMBED}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    expect(seen[2]!.body).toEqual({ properties: { [PROPS.url]: { url: X_CANONICAL } } });
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, claude: false, reason: "no_text_x", tags: 0 }),
    ]);
  });

  it("a no-text X post saved with a client title: lookup skipped, Claude gets the titled shape, its tags land", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    const clientTitle = 'Aaron Levie on X: "https://t.co/Lv1eB0x" / X';
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "Aaron Levie: Box on AI Agents", tags: ["AI"] }));
    mockNotion(record, { name: clientTitle, tags: [] });

    await runInWaitUntil(xJob({ clientTitle }));

    expect(seen.some((s) => s.url.startsWith(OEMBED))).toBe(false);
    const claudeBody = seen.find((s) => s.url === MESSAGES)!.body as ClaudeBody;
    expect(claudeBody.messages).toEqual([{ role: "user", content: `Title: ${clientTitle}\nURL: ${X_STORED}` }]);
    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { ...nameProp("Aaron Levie: Box on AI Agents"), [PROPS.tags]: { multi_select: [{ id: "opt-ai" }] } },
    });
    const line = logs()[0]!;
    expect(line).toMatchObject({ event: "enrich", ok: true, claude: true, tags: 1 });
    expect(line).not.toHaveProperty("reason");
  });
});

// SAT-41: a save with a client title still runs the lookup, only to give Claude context (the
// page description or the X post text). Replaces SAT-12's "client title → no lookup fetch".
describe("SAT-41: a client-title save gives Claude the page summary", () => {
  const CLIENT = "how to get rich | Medium";
  const DESCRIPTION = "Wealth is assets that earn while you sleep.";
  const BODY_TEXT = "This paragraph is page body text and must never reach Claude.";
  const SUMMARY_HTML =
    "<html><head><title>Looked Up Title | Site</title>" +
    `<meta name="description" content="${DESCRIPTION}"></head>` +
    `<body><p>${BODY_TEXT}</p></body></html>`;

  it("criteria 1 and 2: a page save runs the lookup; Claude gets the client title plus the description, no body text", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, SUMMARY_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "How to Get Rich", tags: ["Product"] }));
    mockNotion(record, { name: CLIENT, tags: [] });

    await runInWaitUntil(pageJob({ clientTitle: CLIENT }));

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `GET ${ARTICLE}`,
      `GET ${SCHEMA_URL}`,
      `POST ${MESSAGES}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    const claudeBody = seen[2]!.body as ClaudeBody;
    expect(claudeBody.messages).toEqual([
      { role: "user", content: `Title: ${CLIENT}\nDescription: ${DESCRIPTION}\nURL: ${ARTICLE}` },
    ]);
    expect(JSON.stringify(claudeBody)).not.toContain(BODY_TEXT);
    expect(JSON.stringify(claudeBody)).not.toContain("Looked Up Title");
    expect(seen[4]!.body).toEqual({
      properties: { ...nameProp("How to Get Rich"), [PROPS.tags]: { multi_select: [{ id: "opt-product" }] } },
    });
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, source: "client", patched: true, claude: true, tags: 1 }),
    ]);
  });

  it("criterion 1: with Claude failing, the looked-up title never replaces the client title", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    htmlPage(ARTICLE, record, SUMMARY_HTML);
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claude401());
    mockNotion(record, { name: CLIENT, tags: [] });

    await runInWaitUntil(pageJob({ clientTitle: CLIENT }));

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `GET ${ARTICLE}`,
      `GET ${SCHEMA_URL}`,
      `POST ${MESSAGES}`,
      `GET ${PAGE_URL}`,
    ]);
    // The Name stays the client title, so there's nothing to write and no patch.
    expect(logs().filter((l) => l.event === "enrich")).toEqual([
      expect.objectContaining({ ok: true, source: "client", patched: false, claude: false }),
    ]);
  });

  it("criterion 2: an X save sends Claude the post text (x shape); no URL swap", async () => {
    captureLogs();
    const { seen, record } = recorder();
    const clientTitle = 'Naval on X: "How to Get Rich" / X';
    mockOembed(record, xOembed("How to Get Rich<br>(without getting lucky):"));
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "How to Build Wealth Without Luck", tags: ["AI"] }));
    mockNotion(record, { name: clientTitle, tags: [] });

    await runInWaitUntil(xJob({ clientTitle }));

    expect(seen[0]!.url.startsWith(OEMBED)).toBe(true);
    const claudeBody = seen.find((s) => s.url === MESSAGES)!.body as ClaudeBody;
    expect(claudeBody.messages).toEqual([
      {
        role: "user",
        content: `X post by Naval (@naval): "How to Get Rich (without getting lucky):"\nURL: ${X_STORED}`,
      },
    ]);
    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: {
        ...nameProp("How to Build Wealth Without Luck"),
        [PROPS.tags]: { multi_select: [{ id: "opt-ai" }] },
      },
    });
  });

  it("criterion 4: a no-text X post with a client title gets the titled shape with the client title", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    const clientTitle = 'Aaron Levie on X: "https://t.co/Lv1eB0x" / X';
    mockOembed(record, xOembed('<a href="https://t.co/Lv1eB0x">https://t.co/Lv1eB0x</a>'));
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "Aaron Levie: Box on AI Agents", tags: ["AI"] }));
    mockNotion(record, { name: clientTitle, tags: [] });

    await runInWaitUntil(xJob({ clientTitle }));

    expect(seen[0]!.url.startsWith(OEMBED)).toBe(true);
    const claudeBody = seen.find((s) => s.url === MESSAGES)!.body as ClaudeBody;
    expect(claudeBody.messages).toEqual([{ role: "user", content: `Title: ${clientTitle}\nURL: ${X_STORED}` }]);
    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { ...nameProp("Aaron Levie: Box on AI Agents"), [PROPS.tags]: { multi_select: [{ id: "opt-ai" }] } },
    });
    const line = logs()[0]!;
    expect(line).toMatchObject({ event: "enrich", ok: true, claude: true, tags: 1 });
    expect(line).not.toHaveProperty("reason");
  });

  // Real wait: AbortSignal.timeout runs on workerd's clock, which fake timers don't drive.
  it("criterion 3: a lookup timeout still patches, with Claude on the client title and URL", { timeout: 15_000 }, async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    network.use(
      http.get(ARTICLE, async ({ request }) => {
        await record(request);
        return new Promise<Response>(() => {});
      }),
    );
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "How to Get Rich", tags: ["Product"] }));
    mockNotion(record, { name: CLIENT, tags: [] });

    await runInWaitUntil(pageJob({ clientTitle: CLIENT }));

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `GET ${ARTICLE}`,
      `GET ${SCHEMA_URL}`,
      `POST ${MESSAGES}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    // The lookup gave up (4 s fetch timeout or the 5 s stage cap) before Claude ran.
    const claudeReq = seen[2]!;
    expect(claudeReq.at).toBeGreaterThanOrEqual(3900);
    expect(claudeReq.at).toBeLessThan(5500);
    expect((claudeReq.body as ClaudeBody).messages).toEqual([
      { role: "user", content: `Title: ${CLIENT}\nURL: ${ARTICLE}` },
    ]);
    expect(seen[4]!.body).toEqual({
      properties: { ...nameProp("How to Get Rich"), [PROPS.tags]: { multi_select: [{ id: "opt-product" }] } },
    });
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, source: "client", patched: true, claude: true }),
    ]);
  });
});

describe("SAT-42: an X post's Name is the post text, no author, when Claude fails", () => {
  const notFound = (record: Record_, url: string) =>
    network.use(
      http.get(url, async ({ request }) => {
        await record(request);
        return new HttpResponse("<html></html>", { status: 404, headers: { "content-type": "text/html" } });
      }),
    );

  it("Claude 401 on an oEmbed X save: the patch carries the post text without 'Naval: ', plus the URL swap", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("How to Get Rich<br>  (without getting lucky):"));
    mockSchema(record, OPTIONS);
    mockClaude(record, claude401);
    mockNotion(record, { name: `X post ${X_ID}`, tags: [] });

    await runInWaitUntil(xJob());

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `GET ${OEMBED}`,
      `GET ${SCHEMA_URL}`,
      `POST ${MESSAGES}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    // Claude still sees who wrote it; only the Name drops the author.
    expect((seen[2]!.body as ClaudeBody).messages[0]!.content).toBe(
      `X post by Naval (@naval): "How to Get Rich (without getting lucky):"\nURL: ${X_STORED}`,
    );
    expect(seen[4]!.body).toEqual({
      properties: { ...nameProp("How to Get Rich (without getting lucky):"), [PROPS.url]: { url: X_CANONICAL } },
    });
    const lines = logs();
    expect(lines).toContainEqual({ event: "claude_failed", class: "AuthenticationError", status: 401, requestId: "req_401" });
    expect(lines.filter((l) => l.event === "enrich")).toEqual([
      expect.objectContaining({ ok: true, source: "x-oembed", patched: true, claude: false, tags: 0 }),
    ]);
  });

  it("Claude 401 on a Twitterbot X save: the patch carries og:description without the display name", async () => {
    captureLogs();
    const { seen, record } = recorder();
    notFound(record, OEMBED);
    htmlPage(
      X_STORED,
      record,
      '<html><head><meta property="og:title" content="Naval (@naval) on X"/>' +
        '<meta property="og:description" content="Seek wealth, not money or status."/></head><body></body></html>',
    );
    mockSchema(record, OPTIONS);
    mockClaude(record, claude401);
    mockNotion(record, { name: `X post ${X_ID}`, tags: [] });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: nameProp("Seek wealth, not money or status."),
    });
  });

  it("a 3000-char post: the Name is the text alone, whitespace collapsed, cut at 2000", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("word<br>  ".repeat(600)));
    mockSchema(record, OPTIONS);
    mockClaude(record, claude401);
    mockNotion(record, { name: `X post ${X_ID}`, tags: [] });

    await runInWaitUntil(xJob());

    const body = seen.find((s) => s.method === "PATCH")!.body as {
      properties: Record<string, { title: { text: { content: string } }[] }>;
    };
    const content = body.properties[PROPS.name]!.title[0]!.text.content;
    expect(content).toBe("word ".repeat(400)); // 2000 chars, from "word word …"
    expect(content).toHaveLength(2000);
  });

  it("a post whose own text starts with the author's name keeps it: only the lookup's prefix comes off", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, xOembed("Naval: a podcast about wealth and happiness"));
    mockSchema(record, OPTIONS);
    mockClaude(record, claude401);
    mockNotion(record, { name: `X post ${X_ID}`, tags: [] });

    await runInWaitUntil(xJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toMatchObject({
      properties: nameProp("Naval: a podcast about wealth and happiness"),
    });
  });

  it("both X lookups and Claude fail: no Name is patched, so the '@naval on X' placeholder stays", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    notFound(record, OEMBED);
    notFound(record, X_STORED);
    mockSchema(record, OPTIONS);
    mockClaude(record, claude401);
    mockNotion(record, { name: "@naval on X", tags: [] });

    await runInWaitUntil(xJob({ fallbackTitle: "@naval on X" }));

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `GET ${OEMBED}`,
      `GET ${X_STORED}`,
      `GET ${SCHEMA_URL}`,
      `POST ${MESSAGES}`,
      `GET ${PAGE_URL}`,
    ]);
    expect(logs().filter((l) => l.event === "enrich")).toEqual([
      expect.objectContaining({ ok: true, source: "fallback", patched: false, claude: false }),
    ]);
  });
});

// SAT-43: an X Article (Aaron Levie's x.com/levie/status/2048950940661932319). oEmbed's post
// text is only a t.co link; lookupX reads x.com's page as Twitterbot for the article title, so
// enrich treats it as a post with text. Fixture from the lead's live probe (2026-11-08).
describe("SAT-43: an X Article gets a real title", () => {
  const A = JSON.parse(articleText) as {
    storedUrl: string;
    canonicalUrl: string;
    oembed: Record<string, unknown>;
    page: { ogTitle: string; ogDescription: string };
  };
  // Real oEmbed escapes `<` and `>` as \u003c and \u003e inside the JSON string.
  const OEMBED_BODY = JSON.stringify(A.oembed).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const ogPage = (ogTitle: string, ogDescription: string) =>
    `<html><head><meta property="og:title" content="${ogTitle}"/>` +
    `<meta property="og:description" content="${ogDescription}"/></head><body></body></html>`;
  const articleJob = () => xJob({ storedUrl: A.storedUrl, fallbackTitle: "@levie on X" });
  const PLACEHOLDER = { name: "@levie on X", url: A.storedUrl, tags: [] };

  it("criteria 1 and 2: Claude gets the x shape with the article title; its title and tags land, URL swapped", async () => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, OEMBED_BODY);
    htmlPage(A.storedUrl, record, ogPage(A.page.ogTitle, A.page.ogDescription));
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "The Never-Ending Last Mile of Work", tags: ["AI", "Product"] }));
    mockNotion(record, PLACEHOLDER);

    await runInWaitUntil(articleJob());

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `GET ${OEMBED}`,
      `GET ${A.storedUrl}`,
      `GET ${SCHEMA_URL}`,
      `POST ${MESSAGES}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    expect(seen[1]!.userAgent).toBe("Twitterbot/1.0");
    expect((seen[3]!.body as ClaudeBody).messages).toEqual([
      {
        role: "user",
        content: `X post by Aaron Levie (@levie): "The never-ending last mile of work"\nURL: ${A.storedUrl}`,
      },
    ]);
    expect(seen[5]!.body).toEqual({
      properties: {
        ...nameProp("The Never-Ending Last Mile of Work"),
        [PROPS.url]: { url: A.canonicalUrl },
        [PROPS.tags]: { multi_select: [{ id: "opt-ai" }, { id: "opt-product" }] },
      },
    });
    const line = logs().find((l) => l.event === "enrich")!;
    expect(line).toMatchObject({ ok: true, source: "x-oembed", patched: true, claude: true, tags: 2 });
    expect(line).not.toHaveProperty("reason");
  });

  it("criterion 2 with Claude failing: the Name is the article title alone, no author (SAT-42)", async () => {
    captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, OEMBED_BODY);
    htmlPage(A.storedUrl, record, ogPage(A.page.ogTitle, A.page.ogDescription));
    mockSchema(record, OPTIONS);
    mockClaude(record, claude401);
    mockNotion(record, PLACEHOLDER);

    await runInWaitUntil(articleJob());

    expect(seen.find((s) => s.method === "PATCH")!.body).toEqual({
      properties: { ...nameProp("The never-ending last mile of work"), [PROPS.url]: { url: A.canonicalUrl } },
    });
  });

  it.each([
    ["og:description empty (an image-only post)", ogPage(A.page.ogTitle, "")],
    ["og:description only a URL", ogPage("Aaron Levie on X: &quot;https://t.co/Lv1eB0x&quot; / X", "https://t.co/Lv1eB0x")],
    [
      "X's generic text",
      ogPage("X", "From breaking news and entertainment to sports and politics, get the full story with all the live commentary."),
    ],
  ])("criterion 3: a page that describes no post (%s) keeps the placeholder, no Claude, no tags", async (_label, html) => {
    const logs = captureLogs();
    const { seen, record } = recorder();
    mockOembed(record, OEMBED_BODY);
    htmlPage(A.storedUrl, record, html);
    mockSchema(record, OPTIONS);
    mockClaude(record, () => claudeAnswer({ title: "X Post", tags: ["AI"] }));
    mockNotion(record, PLACEHOLDER);

    await runInWaitUntil(articleJob());

    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `GET ${OEMBED}`,
      `GET ${A.storedUrl}`,
      `GET ${PAGE_URL}`,
      `PATCH ${PAGE_URL}`,
    ]);
    expect(seen[3]!.body).toEqual({ properties: { [PROPS.url]: { url: A.canonicalUrl } } });
    expect(logs()).toEqual([
      expect.objectContaining({ event: "enrich", ok: true, source: "x-oembed", claude: false, reason: "no_text_x", tags: 0 }),
    ]);
  });

  // Real wait: AbortSignal.timeout runs on workerd's clock, which fake timers don't drive.
  it(
    "criterion 1: a hanging page ends at its 4 s fetch timeout, inside the 5 s stage; no text, placeholder kept",
    { timeout: 15_000 },
    async () => {
      const logs = captureLogs();
      const { seen, record } = recorder();
      mockOembed(record, OEMBED_BODY);
      network.use(
        http.get(A.storedUrl, async ({ request }) => {
          await record(request);
          return new Promise<Response>(() => {});
        }),
      );
      mockSchema(record, OPTIONS);
      mockClaude(record, () => claudeAnswer({ title: "X Post", tags: ["AI"] }));
      mockNotion(record, PLACEHOLDER);

      await runInWaitUntil(articleJob());

      const reread = seen.find((s) => s.url === PAGE_URL)!;
      expect(reread.at).toBeGreaterThanOrEqual(3900);
      expect(reread.at).toBeLessThan(5000);
      expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
        `GET ${OEMBED}`,
        `GET ${A.storedUrl}`,
        `GET ${PAGE_URL}`,
        `PATCH ${PAGE_URL}`,
      ]);
      expect(seen[3]!.body).toEqual({ properties: { [PROPS.url]: { url: A.canonicalUrl } } });
      expect(logs()).toEqual([
        expect.objectContaining({ event: "enrich", ok: true, source: "x-oembed", claude: false, reason: "no_text_x" }),
      ]);
    },
  );
});
