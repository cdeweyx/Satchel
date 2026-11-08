// extension/background.js under the node Vitest project, against test/chrome-mock.ts.
// Outbound fetches go through MSW's node interceptor; anything unmocked fails as a
// network error, so nothing here reaches the real network.
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, type ChromeMock } from "./chrome-mock";

const WORKER = "https://satchel.example.workers.dev";
const SAVE = `${WORKER}/save`;
const KEY = "test-satchel-key";

const server = setupServer(http.all("*", () => HttpResponse.error()));

type Seen = { method: string; url: string; key: string | null; type: string | null; body: unknown };
let seen: Seen[];
let mock: ChromeMock;

// Records every request the worker makes to /save, then answers with `reply`.
function onSave(reply: (body: any) => Response | Promise<Response>) {
  server.use(
    http.post(SAVE, async ({ request }) => {
      const body = await request.json();
      seen.push({
        method: request.method,
        url: request.url,
        key: request.headers.get("x-satchel-key"),
        type: request.headers.get("content-type"),
        body,
      });
      return reply(body);
    }),
  );
}

// Loads a fresh copy of the service worker against a fresh chrome mock.
async function boot(storage: Record<string, unknown> = { workerUrl: `${WORKER}/`, key: KEY }) {
  mock = createChromeMock(storage);
  vi.stubGlobal("chrome", mock.chrome);
  vi.resetModules();
  // @ts-expect-error plain JS service worker, no types (D-13)
  await import("../extension/background.js");
}

function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
beforeEach(async () => {
  seen = [];
  await boot();
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

const page = { url: "https://example.com/post", title: "A Post", status: "later" };

describe("save request", () => {
  it("POSTs {url, title, status} to <workerUrl>/save with the key, one trailing slash stripped", async () => {
    onSave(() => HttpResponse.json({ ok: true, id: "page-1" }));
    await mock.sendMessage({ type: "save", ...page });
    expect(seen).toEqual([
      {
        method: "POST",
        url: SAVE,
        key: KEY,
        type: "application/json",
        body: { url: page.url, title: page.title, status: "later" },
      },
    ]);
  });

  it("SAT-58: passes the popup's image and description through to the Worker", async () => {
    onSave(() => HttpResponse.json({ ok: true, id: "page-1" }));
    const preview = { image: "https://cdn.example.com/cover.png", description: "The post, in a sentence." };
    await mock.sendMessage({ type: "save", ...page, ...preview });
    expect(seen.map((r) => r.body)).toEqual([{ url: page.url, title: page.title, status: "later", ...preview }]);
  });
});

describe("success rule: only a JSON body with ok: true", () => {
  it("200 {ok: true, id} is a success with the id", async () => {
    onSave(() => HttpResponse.json({ ok: true, id: "page-1" }));
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: true, id: "page-1" });
  });

  it("200 with a non-JSON body is a failure", async () => {
    onSave(() => new HttpResponse("<html>Worker threw</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: false, error: "unexpected response" });
  });

  it("200 {ok: false, error} is a failure carrying the Worker's error", async () => {
    onSave(() => HttpResponse.json({ ok: false, error: "notion_rate_limited" }));
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: false, error: "notion_rate_limited" });
  });

  it("401 {ok: false, error: unauthorized} is a failure carrying the Worker's error", async () => {
    onSave(() => HttpResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: false, error: "unauthorized" });
  });

  it("a network error is a failure", async () => {
    server.use(http.post(SAVE, () => HttpResponse.error()));
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: false, error: "unexpected response" });
  });

  it("missing settings is a failure and sends nothing", async () => {
    await boot({});
    onSave(() => HttpResponse.json({ ok: true, id: "page-1" }));
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: false, error: "unexpected response" });
    expect(seen).toEqual([]);
  });

  it("a Worker URL with no key is a failure and sends nothing", async () => {
    await boot({ workerUrl: WORKER });
    onSave(() => HttpResponse.json({ ok: true, id: "page-1" }));
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: false, error: "unexpected response" });
    expect(seen).toEqual([]);
  });
});

describe("badge API failure", () => {
  it("never turns a landed save into a failure", async () => {
    onSave(() => HttpResponse.json({ ok: true, id: "page-1" }));
    const action = (mock.chrome as { action: { setBadgeText: () => Promise<void> } }).action;
    action.setBadgeText = () => Promise.reject(new Error("badge API down"));
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: true, id: "page-1" });
    expect(seen).toHaveLength(1);
  });
});

describe("badge", () => {
  it("sets a red ! when a save fails after the popup closed, and clears it on the next success", async () => {
    const { gate, release } = deferred();
    let fail = true;
    onSave(async () => {
      await gate;
      return fail ? HttpResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) : HttpResponse.json({ ok: true, id: "page-1" });
    });

    const popup = mock.connect("popup");
    const reply = mock.sendMessage({ type: "save", ...page });
    await settle();
    popup.close(); // user closes the popup mid-save
    release();
    expect(await reply).toEqual({ ok: false, error: "unauthorized" });
    expect(mock.badge.text).toBe("!");
    expect(mock.badge.color).toBe("#D93025");

    fail = false;
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: true, id: "page-1" });
    expect(mock.badge.text).toBe("");
    expect(mock.badge.calls).toEqual([
      { method: "setBadgeBackgroundColor", color: "#D93025" },
      { method: "setBadgeText", text: "!" },
      { method: "setBadgeText", text: "" },
    ]);
  });

  it("leaves the badge alone when the popup is still open to show the failure", async () => {
    onSave(() => HttpResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    mock.connect("popup");
    expect(await mock.sendMessage({ type: "save", ...page })).toEqual({ ok: false, error: "unauthorized" });
    expect(mock.badge.calls).toEqual([]);
    expect(mock.badge.text).toBe("");
  });

  it("ignores ports that aren't the popup's", async () => {
    onSave(() => HttpResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    mock.connect("something-else");
    await mock.sendMessage({ type: "save", ...page });
    expect(mock.badge.text).toBe("!");
  });
});

describe("per-URL ordering", () => {
  it("sends a favorite pressed right after read only once the read save has finished", async () => {
    const { gate, release } = deferred();
    let readDone = false;
    onSave(async (body) => {
      if (body.status === "read") {
        await gate;
        readDone = true;
        return HttpResponse.json({ ok: true, id: "page-1" });
      }
      // The favorite must not reach the Worker while the read is still in flight.
      return HttpResponse.json(readDone ? { ok: true, id: "page-1" } : { ok: false, error: "out_of_order" });
    });

    const read = mock.sendMessage({ type: "save", ...page, status: "read" });
    const favorite = mock.sendMessage({ type: "save", ...page, status: "favorite" });
    await settle();
    expect(seen.map((r) => (r.body as { status: string }).status)).toEqual(["read"]);

    release();
    expect(await read).toEqual({ ok: true, id: "page-1" });
    expect(await favorite).toEqual({ ok: true, id: "page-1" });
    expect(seen.map((r) => (r.body as { status: string }).status)).toEqual(["read", "favorite"]);
  });

  it("still sends the favorite after a failed read", async () => {
    onSave((body) =>
      body.status === "read"
        ? HttpResponse.json({ ok: false, error: "notion_conflict" }, { status: 502 })
        : HttpResponse.json({ ok: true, id: "page-1" }),
    );
    mock.connect("popup");
    const read = mock.sendMessage({ type: "save", ...page, status: "read" });
    const favorite = mock.sendMessage({ type: "save", ...page, status: "favorite" });
    expect(await read).toEqual({ ok: false, error: "notion_conflict" });
    expect(await favorite).toEqual({ ok: true, id: "page-1" });
    expect(seen.map((r) => (r.body as { status: string }).status)).toEqual(["read", "favorite"]);
  });

  it("doesn't hold a save for one URL behind another URL's", async () => {
    const { gate, release } = deferred();
    onSave(async (body) => {
      if (body.url === page.url) await gate;
      return HttpResponse.json({ ok: true, id: body.url });
    });
    const slow = mock.sendMessage({ type: "save", ...page });
    const other = await mock.sendMessage({ type: "save", ...page, url: "https://example.org/other" });
    expect(other).toEqual({ ok: true, id: "https://example.org/other" });
    release();
    expect(await slow).toEqual({ ok: true, id: page.url });
  });
});
