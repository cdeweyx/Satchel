/// <reference types="vite/client" />
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../src/canonical";
import { NOTION_VERSION, PROPS } from "../src/config";
import type { EnrichJob } from "../src/contract";
import { enrich } from "../src/enrich";
import worker from "../src/index";
import { notion, titleProp } from "../src/notion";
import { type DedupeFilter, dedupeFilter, handleSave } from "../src/save";
import fixturesText from "./fixtures/dedupe.json?raw";
import { network } from "./network";

// enrich is a spy that calls through to the real no-op stub unless a test overrides one call.
vi.mock("../src/enrich", { spy: true });

const fixtures = JSON.parse(fixturesText) as Record<
  "plain" | "nytimes" | "root" | "x",
  Record<string, DedupeFilter>
>;

const API = "https://api.notion.com/v1";
const DS = "test-data-source-id"; // vitest.config.ts bindings
const KEY = "test-satchel-key";
const TOKEN = "test-notion-token";
const QUERY_PATH = `/data_sources/${DS}/query`;
const OLDEST = "aaaaaaaa-0000-0000-0000-000000000001";
const NEWER = "aaaaaaaa-0000-0000-0000-000000000002";
const CREATED = "bbbbbbbb-0000-0000-0000-000000000003";

type WorkerRequest = Request<unknown, IncomingRequestCfProperties>;
type Seen = { method: string; path: string; body: any; version: string | null };
type Failure = { status: number; body?: unknown; headers?: Record<string, string> } | "network";

const page = (id: string) => ({ object: "page", id, properties: {} });
const notionError = (status: number, code: string) => ({
  object: "error",
  status,
  code,
  message: "mocked",
  request_id: "req-1",
});

// MSW handlers for the three sync endpoints. Every request lands in `seen` (and `events`, for
// ordering) with its parsed body, as Notion would receive it.
function mockNotion(
  opts: {
    results?: string[];
    fail?: Partial<Record<"query" | "create" | "patch", Failure>>;
    beforeQuery?: () => Promise<void>;
  } = {},
) {
  const seen: Seen[] = [];
  const events: string[] = [];
  const record = async (request: Request) => {
    const path = new URL(request.url).pathname.replace(/^\/v1/, "");
    const text = await request.text();
    seen.push({
      method: request.method,
      path,
      body: text ? JSON.parse(text) : undefined,
      version: request.headers.get("notion-version"),
    });
    events.push(`${request.method} ${path}`);
  };
  const failWith = (f: Failure) =>
    f === "network"
      ? HttpResponse.error()
      : HttpResponse.json(f.body ?? null, { status: f.status, headers: f.headers });

  network.use(
    http.post(`${API}${QUERY_PATH}`, async ({ request }) => {
      await record(request);
      await opts.beforeQuery?.();
      if (opts.fail?.query) return failWith(opts.fail.query);
      return HttpResponse.json({ object: "list", results: (opts.results ?? []).map(page), has_more: false });
    }),
    http.post(`${API}/pages`, async ({ request }) => {
      await record(request);
      if (opts.fail?.create) return failWith(opts.fail.create);
      return HttpResponse.json(page(CREATED));
    }),
    http.patch(`${API}/pages/:id`, async ({ request, params }) => {
      await record(request);
      if (opts.fail?.patch) return failWith(opts.fail.patch);
      return HttpResponse.json(page(String(params.id)));
    }),
  );
  return { seen, events };
}

function saveRequest(body: Record<string, unknown>): WorkerRequest {
  return new Request("https://satchel.test/save", {
    method: "POST",
    headers: { "x-satchel-key": KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as WorkerRequest;
}

// End to end through the router, so handleSave reads the original, unread request body.
async function call(body: Record<string, unknown>): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(saveRequest(body), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function expectJson(res: Response, status: number, body: Record<string, unknown>) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.json()).toEqual(body);
}

const statusMap = [
  ["later", false, false],
  ["read", true, false],
  ["favorite", true, true],
] as const;

const statusProps = (archived: boolean, favorite: boolean) => ({
  [PROPS.archived]: { checkbox: archived },
  [PROPS.favorite]: { checkbox: favorite },
});

const queryBody = (filter: DedupeFilter) => ({
  filter,
  sorts: [{ timestamp: "created_time", direction: "ascending" }],
  page_size: 5,
});

let logs: Record<string, unknown>[];
let rawLogs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logs = [];
  rawLogs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    rawLogs.push(String(line));
    try {
      logs.push(JSON.parse(String(line)));
    } catch {
      // not one of ours
    }
  });
});

afterEach(() => {
  logSpy.mockRestore();
  vi.mocked(enrich).mockClear();
  for (const line of rawLogs) {
    expect(line).not.toContain(KEY);
    expect(line).not.toContain(TOKEN);
  }
});

describe("criterion 1: dedupe filter from DedupeKey", () => {
  it.each(Object.entries({ ...fixtures.plain, ...fixtures.root }))(
    "URL %s → 9 clauses in one flat or",
    (input, expected) => {
      const filter = dedupeFilter(canonicalize(input).dedupe);
      expect(filter).toEqual(expected);
      expect("or" in filter && filter.or).toHaveLength(9);
    },
  );

  it.each(Object.entries(fixtures.x))("X %s → one contains /status/<id>", (input, expected) => {
    expect(dedupeFilter(canonicalize(input).dedupe)).toEqual(expected);
  });

  it("nytimes m./www./bare: each matches the fixture; 8 shared clauses, the 9th is its own input", () => {
    const entries = Object.entries(fixtures.nytimes);
    expect(entries).toHaveLength(3);
    const filters = entries.map(([input, expected]) => {
      const filter = dedupeFilter(canonicalize(input).dedupe) as { or: unknown[] };
      expect(filter).toEqual(expected);
      expect(filter.or).toHaveLength(9);
      expect(filter.or[8]).toEqual({ property: PROPS.url, url: { equals: input } });
      return filter;
    });
    expect(filters[1]!.or.slice(0, 8)).toEqual(filters[0]!.or.slice(0, 8));
    expect(filters[2]!.or.slice(0, 8)).toEqual(filters[0]!.or.slice(0, 8));
  });

  it("nytimes: every form's filter matches every form's stored URL with an equals clause", () => {
    const inputs = Object.keys(fixtures.nytimes);
    const stored = inputs.map((i) => canonicalize(i).stored);
    for (const input of inputs) {
      const filter = dedupeFilter(canonicalize(input).dedupe) as { or: unknown[] };
      for (const s of stored) expect(filter.or).toContainEqual({ property: PROPS.url, url: { equals: s } });
    }
  });

  it("the query sent to Notion carries the fixture filter, oldest first, page_size 5", async () => {
    const [[plainUrl, plainFilter]] = Object.entries(fixtures.plain) as [[string, DedupeFilter]];
    const [[xUrl, xFilter]] = Object.entries(fixtures.x) as [[string, DedupeFilter]];
    const { seen } = mockNotion();
    await call({ url: plainUrl, status: "later" });
    await call({ url: xUrl, status: "later" });
    const queries = seen.filter((s) => s.path === QUERY_PATH);
    expect(queries.map((q) => q.body)).toEqual([queryBody(plainFilter), queryBody(xFilter)]);
    expect(queries.every((q) => q.version === NOTION_VERSION)).toBe(true);
  });

  it("a padded URL is trimmed: the raw clause is the trimmed input", async () => {
    const input = "https://nytimes.com/2025/01/27/technology/deepseek.html";
    const { seen } = mockNotion();
    await call({ url: `  ${input}\n`, status: "later" });
    expect(seen[0]!.body.filter).toEqual(fixtures.nytimes[input]);
  });
});

describe("criterion 2: hit patches status only, miss creates the row", () => {
  it.each(statusMap)("hit, %s → PATCH Archived %s, Favorite %s on the oldest match only", async (status, a, f) => {
    const { seen } = mockNotion({ results: [OLDEST, NEWER] });
    const res = await call({ url: "https://example.com/post", title: "A Client Title", status });
    await expectJson(res, 200, { ok: true, id: OLDEST });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`POST ${QUERY_PATH}`, `PATCH /pages/${OLDEST}`]);
    expect(seen[1]!.body).toEqual({ properties: statusProps(a, f) });
    const keys = Object.keys(seen[1]!.body.properties);
    for (const never of [PROPS.name, PROPS.tags, PROPS.url, PROPS.media]) expect(keys).not.toContain(never);
  });

  it.each(statusMap)("miss, %s → create with Name, URL, Archived %s, Favorite %s, Media; no Tags", async (status, a, f) => {
    const { seen } = mockNotion();
    const res = await call({
      url: "https://www.example.com/blog/post/?utm_source=news",
      title: "  A Client Title  ",
      status,
    });
    await expectJson(res, 200, { ok: true, id: CREATED });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`POST ${QUERY_PATH}`, "POST /pages"]);
    expect(seen[1]!.body).toEqual({
      parent: { type: "data_source_id", data_source_id: DS },
      properties: {
        [PROPS.name]: { title: [{ text: { content: "A Client Title" } }] },
        [PROPS.url]: { url: "https://www.example.com/blog/post" },
        ...statusProps(a, f),
        [PROPS.media]: { checkbox: false },
      },
    });
    expect(Object.keys(seen[1]!.body.properties)).not.toContain(PROPS.tags);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["the raw URL", "https://www.example.com/blog/my-first-post?utm_source=x"],
    ["the stored URL", "https://www.example.com/blog/my-first-post"],
  ])("miss with a missing title (%s) → Name is the fallback title", async (_label, title) => {
    const { seen } = mockNotion();
    await call({ url: "https://www.example.com/blog/my-first-post?utm_source=x", title, status: "later" });
    expect(seen[1]!.body.properties[PROPS.name]).toEqual({
      title: [{ text: { content: "My first post · example.com" } }],
    });
  });

  it("miss on a media host → Media true, URL is the stored form", async () => {
    const { seen } = mockNotion();
    await call({ url: "https://youtu.be/dQw4w9WgXcQ?si=abc123", status: "read" });
    expect(seen[1]!.body.properties[PROPS.url]).toEqual({ url: "https://youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(seen[1]!.body.properties[PROPS.media]).toEqual({ checkbox: true });
  });

  it("logs one save line per outcome: action, kind, ms", async () => {
    mockNotion({ results: [OLDEST] });
    await call({ url: "https://x.com/jack/status/20", status: "later" });
    expect(logs.filter((l) => l.event === "save")).toEqual([
      { event: "save", action: "update", kind: "x", ms: expect.any(Number) },
    ]);
  });
});

describe("criterion 3: the save promise goes to waitUntil as well as being awaited", () => {
  it("is registered before the response resolves and settles only after the write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let queryArrived!: () => void;
    const arrived = new Promise<void>((r) => (queryArrived = r));
    const { seen } = mockNotion({
      beforeQuery: async () => {
        queryArrived();
        await gate;
      },
    });

    const ctx = createExecutionContext();
    const registered: Promise<unknown>[] = [];
    const realWaitUntil = ctx.waitUntil.bind(ctx);
    ctx.waitUntil = (p: Promise<unknown>) => {
      registered.push(p);
      realWaitUntil(p);
    };

    let responded = false;
    const resP = worker.fetch(saveRequest({ url: "https://example.com/a", status: "later" }), env, ctx).then(
      (r) => {
        responded = true;
        return r;
      },
    );

    await arrived; // the dedupe query is in flight and held
    expect(responded).toBe(false);
    expect(registered).toHaveLength(1);
    let requestsWhenSettled = -1;
    void registered[0]!.then(() => (requestsWhenSettled = seen.length));
    await new Promise((r) => setTimeout(r, 10));
    expect(requestsWhenSettled).toBe(-1); // still pending with the save

    release();
    await expectJson(await resP, 200, { ok: true, id: CREATED });
    await registered[0];
    expect(requestsWhenSettled).toBe(2); // settled after the query and the create
    await waitOnExecutionContext(ctx);
  });

  it("the waitUntil copy never rejects, while a non-Notion error still reaches the caller", async () => {
    const ctx = createExecutionContext();
    const registered: Promise<unknown>[] = [];
    const realWaitUntil = ctx.waitUntil.bind(ctx);
    ctx.waitUntil = (p: Promise<unknown>) => {
      registered.push(p);
      realWaitUntil(p);
    };
    // The router never lets this through; called directly, canonicalize throws a plain Error.
    const req = new Request("https://satchel.test/save", {
      method: "POST",
      body: JSON.stringify({ url: "ftp://example.com/f", status: "later" }),
    });
    await expect(handleSave(req, env, ctx)).rejects.toThrow(/unsupported scheme/);
    expect(registered).toHaveLength(1);
    await expect(registered[0]).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });
});

describe("criterion 4: any NotionError → 502 notion_<code>, no retry", () => {
  const retryAfter = { "Retry-After": "30" };
  const cases: Array<[string, "query" | "create" | "patch", Failure, string, string[]]> = [
    ["429 on query", "query", { status: 429, body: notionError(429, "rate_limited"), headers: retryAfter }, "notion_rate_limited", ["query"]],
    ["503 on query", "query", { status: 503, body: notionError(503, "service_unavailable") }, "notion_service_unavailable", ["query"]],
    ["429 on create", "create", { status: 429, body: notionError(429, "rate_limited"), headers: retryAfter }, "notion_rate_limited", ["query", "create"]],
    ["503 on create", "create", { status: 503, body: notionError(503, "service_unavailable") }, "notion_service_unavailable", ["query", "create"]],
    ["429 on patch", "patch", { status: 429, body: notionError(429, "rate_limited"), headers: retryAfter }, "notion_rate_limited", ["query", "patch"]],
    ["503 on patch", "patch", { status: 503, body: notionError(503, "service_unavailable") }, "notion_service_unavailable", ["query", "patch"]],
    ["503 with a non-JSON body", "create", { status: 503, body: "<html>" }, "notion_http_503", ["query", "create"]],
    ["network failure", "query", "network", "notion_unreachable", ["query"]],
  ];
  const label = { query: `POST ${QUERY_PATH}`, create: "POST /pages", patch: `PATCH /pages/${OLDEST}` };

  it.each(cases)("%s → 502 at once, one attempt", async (_name, stage, failure, error, requests) => {
    const { seen } = mockNotion({ results: stage === "patch" ? [OLDEST] : [], fail: { [stage]: failure } });
    const start = performance.now();
    const res = await call({ url: "https://example.com/a", status: "later" });
    expect(performance.now() - start).toBeLessThan(1000);
    await expectJson(res, 502, { ok: false, error });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(requests.map((r) => label[r as keyof typeof label]));
    const code = error.replace(/^notion_/, "");
    expect(logs.filter((l) => l.event === "save_failed")).toEqual([
      { event: "save_failed", code, status: failure === "network" ? 0 : failure.status, stage },
    ]);
    expect(vi.mocked(enrich)).not.toHaveBeenCalled();
  });

  it("an over-long stored URL fails the guard before any request: 502 notion_url_too_long", async () => {
    // youtu.be/<id> expands to youtube.com/watch?v=<id>: a 2000-char raw URL stores at 2011.
    const raw = `https://youtu.be/${"a".repeat(2000 - "https://youtu.be/".length)}`;
    expect(raw).toHaveLength(2000);
    const { seen } = mockNotion();
    await expectJson(await call({ url: raw, status: "later" }), 502, { ok: false, error: "notion_url_too_long" });
    expect(seen).toEqual([]);
    expect(logs.filter((l) => l.event === "save_failed")).toEqual([
      { event: "save_failed", code: "url_too_long", status: 400, stage: "guard" },
    ]);
  });

  it("sync calls time out at 3 s, not the client's 5 s default", { timeout: 10_000 }, async () => {
    network.use(
      http.post(`${API}${QUERY_PATH}`, async () => {
        await new Promise((r) => setTimeout(r, 4500));
        return HttpResponse.json({ object: "list", results: [] });
      }),
    );
    const start = performance.now();
    const res = await call({ url: "https://example.com/a", status: "later" });
    const elapsed = performance.now() - start;
    await expectJson(res, 502, { ok: false, error: "notion_timeout" });
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(4000);
  });
});

describe("criterion 5: the D-1 boundary", () => {
  it("no PATCH before the response; enrich runs after with the full EnrichJob", async () => {
    const { seen, events } = mockNotion();
    // A stand-in for the real enrich: wait a tick, then PATCH the page like SAT-12 will.
    vi.mocked(enrich).mockImplementationOnce(async (job, e) => {
      await new Promise((r) => setTimeout(r, 0));
      await notion(e).patchPage(job.pageId, titleProp("Looked Up Title"), { timeoutMs: 3000 });
    });

    const ctx = createExecutionContext();
    let patchesAtResponse = -1;
    const res = await worker
      .fetch(saveRequest({ url: "https://twitter.com/jack/status/20?s=46", status: "favorite" }), env, ctx)
      .then((r) => {
        events.push("response");
        patchesAtResponse = seen.filter((s) => s.method === "PATCH").length;
        return r;
      });
    expect(patchesAtResponse).toBe(0);
    await expectJson(res, 200, { ok: true, id: CREATED });

    await waitOnExecutionContext(ctx);
    expect(events).toEqual([`POST ${QUERY_PATH}`, "POST /pages", "response", `PATCH /pages/${CREATED}`]);
    expect(seen[2]!.body).toEqual({ properties: titleProp("Looked Up Title") });

    expect(vi.mocked(enrich).mock.calls).toHaveLength(1);
    const job = vi.mocked(enrich).mock.calls[0]![0] as EnrichJob;
    expect(job).toEqual({
      pageId: CREATED,
      storedUrl: "https://x.com/i/status/20",
      kind: "x",
      fallbackTitle: "@jack on X",
    });
    expect(job.clientTitle).toBeUndefined();
  });

  it("a client title reaches the EnrichJob trimmed, with the fallback still computed", async () => {
    mockNotion();
    await call({ url: "https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5", title: " Ep 1 ", status: "later" });
    expect(vi.mocked(enrich).mock.calls.map((c) => c[0])).toEqual([
      {
        pageId: CREATED,
        storedUrl: "https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5",
        kind: "media",
        clientTitle: "Ep 1",
        fallbackTitle: "7makk4oTQel546B0PZlDM5 · open.spotify.com",
      },
    ]);
  });
});

describe("criterion 6: a dedupe hit runs no enrich and no extra PATCH", () => {
  it("one query, one status PATCH, nothing after", async () => {
    const { seen } = mockNotion({ results: [OLDEST] });
    const res = await call({ url: "https://example.com/a", title: "New Title", status: "read" });
    await expectJson(res, 200, { ok: true, id: OLDEST });
    expect(vi.mocked(enrich).mock.calls).toEqual([]);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`POST ${QUERY_PATH}`, `PATCH /pages/${OLDEST}`]);
    expect(seen[1]!.body).toEqual({ properties: statusProps(true, false) });
  });
});

describe("criterion 7: 200 {ok:true, id} for create and update", () => {
  it("create returns the new page id", async () => {
    mockNotion();
    await expectJson(await call({ url: "https://example.com/new", status: "later" }), 200, { ok: true, id: CREATED });
  });

  it("update returns the matched page id", async () => {
    mockNotion({ results: [OLDEST] });
    await expectJson(await call({ url: "https://example.com/old", status: "later" }), 200, { ok: true, id: OLDEST });
  });
});
