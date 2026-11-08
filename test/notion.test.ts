import { env } from "cloudflare:workers";
import { type HttpResponseResolver, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { NOTION_VERSION, PROPS } from "../src/config";
import {
  NotionError,
  type Properties,
  checkboxProp,
  isTagRef,
  notion,
  tagIdsProp,
  titleProp,
  urlProp,
} from "../src/notion";
import { network } from "./network";

const API = "https://api.notion.com/v1";
const DS = "test-data-source-id"; // vitest.config.ts binding
const PAGE_ID = "11111111-2222-3333-4444-555555555555";

type Captured = {
  method: string;
  url: string;
  headers: Record<string, string | null>;
  body: unknown;
};

// Records every request a handler sees: method, URL, the headers we care about, parsed body.
function recorder() {
  const seen: Captured[] = [];
  const record = async (request: {
    method: string;
    url: string;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }) => {
    const text = await request.text();
    seen.push({
      method: request.method,
      url: request.url,
      headers: {
        authorization: request.headers.get("authorization"),
        "notion-version": request.headers.get("notion-version"),
        "content-type": request.headers.get("content-type"),
      },
      body: text ? JSON.parse(text) : undefined,
    });
  };
  return { seen, record };
}

const page = (id: string) => ({ object: "page", id, properties: {} });
const notionErrorBody = (status: number, code: string, message: string) => ({
  object: "error",
  status,
  code,
  message,
  request_id: "req-1",
  additional_data: {},
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("notion client endpoints", () => {
  it("retrieveDataSource GETs the data source with auth and the pinned version", async () => {
    const { seen, record } = recorder();
    const schema = {
      object: "data_source",
      id: DS,
      properties: {
        [PROPS.tags]: {
          id: "t",
          name: PROPS.tags,
          type: "multi_select",
          multi_select: { options: [{ id: "opt-1", name: "AI", color: "blue" }] },
        },
      },
    };
    network.use(
      http.get(`${API}/data_sources/${DS}`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(schema);
      }),
    );

    const result = await notion(env).retrieveDataSource();

    expect(result).toEqual(schema);
    expect(seen).toEqual([
      {
        method: "GET",
        url: `${API}/data_sources/${DS}`,
        headers: {
          authorization: "Bearer test-notion-token",
          "notion-version": "2026-03-11",
          "content-type": "application/json",
        },
        body: undefined,
      },
    ]);
  });

  it("query POSTs the filter with page_size 5, created_time ascending, and returns results", async () => {
    const { seen, record } = recorder();
    const results = [page("a"), page("b")];
    network.use(
      http.post(`${API}/data_sources/${DS}/query`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ object: "list", results, has_more: false, next_cursor: null });
      }),
    );
    const filter = {
      or: [
        { property: PROPS.url, url: { equals: "https://example.com/a" } },
        { property: PROPS.url, url: { starts_with: "https://example.com/a?" } },
      ],
    };

    const out = await notion(env).query(filter);

    expect(out).toEqual(results);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers["notion-version"]).toBe(NOTION_VERSION);
    expect(seen[0]!.body).toEqual({
      filter,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 5,
    });
  });

  it("createPage POSTs under the data source parent with the built properties", async () => {
    const { seen, record } = recorder();
    network.use(
      http.post(`${API}/pages`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(page(PAGE_ID));
      }),
    );
    const props: Properties = {
      ...titleProp("Hello World"),
      ...urlProp("https://example.com/a"),
      ...checkboxProp("archived", true),
      ...checkboxProp("favorite", false),
      ...tagIdsProp(["opt-1", "opt-2"]),
    };

    const created = await notion(env).createPage(props);

    expect(created.id).toBe(PAGE_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.authorization).toBe("Bearer test-notion-token");
    expect(seen[0]!.headers["notion-version"]).toBe(NOTION_VERSION);
    expect(seen[0]!.body).toEqual({
      parent: { type: "data_source_id", data_source_id: DS },
      properties: {
        Name: { title: [{ text: { content: "Hello World" } }] },
        URL: { url: "https://example.com/a" },
        Archived: { checkbox: true },
        Favorite: { checkbox: false },
        Tags: { multi_select: [{ id: "opt-1" }, { id: "opt-2" }] },
      },
    });
  });

  it("patchPage PATCHes /pages/{id} with only the given properties", async () => {
    const { seen, record } = recorder();
    network.use(
      http.patch(`${API}/pages/${PAGE_ID}`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(page(PAGE_ID));
      }),
    );

    const patched = await notion(env).patchPage(PAGE_ID, {
      ...checkboxProp("archived", true),
      ...checkboxProp("favorite", true),
    });

    expect(patched.id).toBe(PAGE_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.url).toBe(`${API}/pages/${PAGE_ID}`);
    expect(seen[0]!.headers["notion-version"]).toBe(NOTION_VERSION);
    expect(seen[0]!.body).toEqual({
      properties: { Archived: { checkbox: true }, Favorite: { checkbox: true } },
    });
  });

  it("retrievePage GETs /pages/{id} and returns the page", async () => {
    const { seen, record } = recorder();
    const body = {
      object: "page",
      id: PAGE_ID,
      properties: { Name: { type: "title", title: [{ plain_text: "Hi" }] } },
    };
    network.use(
      http.get(`${API}/pages/${PAGE_ID}`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(body);
      }),
    );

    expect(await notion(env).retrievePage(PAGE_ID)).toEqual(body);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers["notion-version"]).toBe(NOTION_VERSION);
    expect(seen[0]!.headers.authorization).toBe("Bearer test-notion-token");
  });
});

describe("no retry", () => {
  for (const [status, code] of [
    [429, "rate_limited"],
    [529, "service_overload"],
  ] as const) {
    it(`a ${status} with Retry-After throws ${code} at once, one request, no sleep`, async () => {
      let calls = 0;
      network.use(
        http.post(`${API}/pages`, () => {
          calls++;
          return HttpResponse.json(notionErrorBody(status, code, "slow down"), {
            status,
            headers: { "Retry-After": "30" },
          });
        }),
      );

      const start = performance.now();
      const err = await caught(notion(env).createPage(titleProp("x")));
      const elapsed = performance.now() - start;

      expect(err).toBeInstanceOf(NotionError);
      expect(err).toMatchObject({ status, code });
      expect(calls).toBe(1);
      expect(elapsed).toBeLessThan(50);
    });
  }
});

describe("error mapping", () => {
  it("maps a Notion error body to NotionError with status and code preserved", async () => {
    network.use(
      http.get(`${API}/pages/${PAGE_ID}`, () =>
        HttpResponse.json(
          notionErrorBody(404, "object_not_found", 'Not shared with your integration "Satchel".'),
          { status: 404 },
        ),
      ),
    );

    const err = await caught(notion(env).retrievePage(PAGE_ID));

    expect(err).toBeInstanceOf(NotionError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 404, code: "object_not_found" });
    // SAT-6 builds the Worker error straight from the code.
    expect(`notion_${(err as NotionError).code}`).toBe("notion_object_not_found");
  });

  it("maps a validation_error on query to its code", async () => {
    network.use(
      http.post(`${API}/data_sources/${DS}/query`, () =>
        HttpResponse.json(notionErrorBody(400, "validation_error", "bad filter"), { status: 400 }),
      ),
    );
    const err = await caught(notion(env).query({}));
    expect(err).toMatchObject({ status: 400, code: "validation_error" });
  });

  it("maps a non-2xx with an unparsable body to http_<status>", async () => {
    network.use(
      http.get(`${API}/data_sources/${DS}`, () =>
        new HttpResponse("<html>Bad Gateway</html>", { status: 502 }),
      ),
    );
    const err = await caught(notion(env).retrieveDataSource());
    expect(err).toBeInstanceOf(NotionError);
    expect(err).toMatchObject({ status: 502, code: "http_502" });
  });

  it("maps a non-2xx with JSON that isn't a Notion error to http_<status>", async () => {
    network.use(
      http.get(`${API}/data_sources/${DS}`, () =>
        HttpResponse.json({ hello: "world" }, { status: 503 }),
      ),
    );
    const err = await caught(notion(env).retrieveDataSource());
    expect(err).toMatchObject({ status: 503, code: "http_503" });
  });

  it("maps a network failure to status 0 unreachable", async () => {
    network.use(http.post(`${API}/pages`, () => HttpResponse.error()));
    const err = await caught(notion(env).createPage(titleProp("x")));
    expect(err).toBeInstanceOf(NotionError);
    expect(err).toMatchObject({ status: 0, code: "unreachable" });
  });

  it("maps the per-call timeout firing to status 0 timeout", async () => {
    network.use(
      http.get(`${API}/pages/${PAGE_ID}`, async () => {
        await new Promise((r) => setTimeout(r, 2000));
        return HttpResponse.json(page(PAGE_ID));
      }),
    );
    const start = performance.now();
    const err = await caught(notion(env).retrievePage(PAGE_ID, { timeoutMs: 30 }));
    const elapsed = performance.now() - start;
    expect(err).toBeInstanceOf(NotionError);
    expect(err).toMatchObject({ status: 0, code: "timeout" });
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("tags by id only", () => {
  it("tagIdsProp writes multi_select as [{id}] and nothing else", () => {
    expect(tagIdsProp(["a", "b"])).toEqual({ Tags: { multi_select: [{ id: "a" }, { id: "b" }] } });
  });

  it("isTagRef accepts {id} and rejects anything with a name key", () => {
    expect(isTagRef({ id: "a" })).toBe(true);
    expect(isTagRef({ name: "AI" })).toBe(false);
    expect(isTagRef({ id: "a", name: "AI" })).toBe(false);
    expect(isTagRef({ id: 1 })).toBe(false);
    expect(isTagRef(null)).toBe(false);
    expect(isTagRef("a")).toBe(false);
  });

  it("createPage and patchPage reject a multi_select by name before any request", async () => {
    let calls = 0;
    network.use(
      http.all(`${API}/*`, () => {
        calls++;
        return HttpResponse.json(page(PAGE_ID));
      }),
    );
    // Bypasses the types, as a buggy caller would.
    const byName = { Tags: { multi_select: [{ name: "Brand New Tag" }] } } as unknown as Properties;
    const mixed = { Tags: { multi_select: [{ id: "a", name: "AI" }] } } as unknown as Properties;

    await expect(notion(env).createPage(byName)).rejects.toThrow(TypeError);
    await expect(notion(env).patchPage(PAGE_ID, mixed)).rejects.toThrow(TypeError);
    expect(calls).toBe(0);
  });
});

describe("size limits", () => {
  it("truncates title content to 2000 chars in the request sent", async () => {
    const { seen, record } = recorder();
    network.use(
      http.post(`${API}/pages`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(page(PAGE_ID));
      }),
    );
    const long = "a".repeat(2500);

    await notion(env).createPage(titleProp(long));

    const sent = (seen[0]!.body as { properties: { Name: { title: { text: { content: string } }[] } } })
      .properties.Name.title[0]!.text.content;
    expect(sent).toBe("a".repeat(2000));
  });

  it("truncation keeps a 2000-char title whole and never splits a surrogate pair", () => {
    const exact = "b".repeat(2000);
    expect(titleProp(exact)).toEqual({ Name: { title: [{ text: { content: exact } }] } });
    // 1999 ASCII chars then an emoji (2 UTF-16 units) straddling the limit.
    const straddle = "c".repeat(1999) + "😀" + "tail";
    const content = (titleProp(straddle).Name as { title: { text: { content: string } }[] })
      .title[0]!.text.content;
    expect(content).toBe("c".repeat(1999));
  });

  it("truncates a hand-built over-long title too", async () => {
    const { seen, record } = recorder();
    network.use(
      http.patch(`${API}/pages/${PAGE_ID}`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(page(PAGE_ID));
      }),
    );
    await notion(env).patchPage(PAGE_ID, { Name: { title: [{ text: { content: "z".repeat(3000) } }] } });
    expect(seen[0]!.body).toEqual({
      properties: { Name: { title: [{ text: { content: "z".repeat(2000) } }] } },
    });
  });

  it("urlProp rejects a URL over 2000 chars with NotionError 400 url_too_long", () => {
    const tooLong = "https://example.com/" + "p".repeat(2000 - 19);
    expect(tooLong.length).toBe(2001);
    let err: unknown;
    try {
      urlProp(tooLong);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotionError);
    expect(err).toMatchObject({ status: 400, code: "url_too_long" });
    // Exactly 2000 is allowed.
    expect(urlProp(tooLong.slice(0, 2000))).toEqual({ URL: { url: tooLong.slice(0, 2000) } });
  });

  it("createPage rejects a hand-built URL over 2000 chars before any request", async () => {
    let calls = 0;
    network.use(
      http.all(`${API}/*`, () => {
        calls++;
        return HttpResponse.json(page(PAGE_ID));
      }),
    );
    const props: Properties = { URL: { url: "https://example.com/" + "q".repeat(2000) } };

    const err = await caught(notion(env).createPage(props));

    expect(err).toBeInstanceOf(NotionError);
    expect(err).toMatchObject({ status: 400, code: "url_too_long" });
    expect(calls).toBe(0);
  });
});

describe("every endpoint", () => {
  it("sends Notion-Version 2026-03-11 and the bearer token on all five calls", async () => {
    const { seen, record } = recorder();
    const respond: HttpResponseResolver = async ({ request }) => {
      await record(request);
      return HttpResponse.json(
        request.url.endsWith("/query") ? { object: "list", results: [] } : page(PAGE_ID),
      );
    };
    network.use(
      http.get(`${API}/data_sources/${DS}`, respond),
      http.post(`${API}/data_sources/${DS}/query`, respond),
      http.post(`${API}/pages`, respond),
      http.patch(`${API}/pages/${PAGE_ID}`, respond),
      http.get(`${API}/pages/${PAGE_ID}`, respond),
    );
    const client = notion(env);

    await client.retrieveDataSource();
    await client.query({});
    await client.createPage(titleProp("x"));
    await client.patchPage(PAGE_ID, checkboxProp("media", true));
    await client.retrievePage(PAGE_ID);

    expect(seen.map((r) => `${r.method} ${r.url.replace(API, "")}`)).toEqual([
      `GET /data_sources/${DS}`,
      `POST /data_sources/${DS}/query`,
      "POST /pages",
      `PATCH /pages/${PAGE_ID}`,
      `GET /pages/${PAGE_ID}`,
    ]);
    for (const r of seen) {
      expect(r.headers["notion-version"]).toBe("2026-03-11");
      expect(r.headers.authorization).toBe("Bearer test-notion-token");
    }
  });
});
