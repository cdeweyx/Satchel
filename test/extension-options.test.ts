// extension/options.js under the node Vitest project, against test/chrome-mock.ts and a
// small fake DOM. Tests drive the page through its events (submit, click, keydown) and
// assert on the words it renders and what lands in chrome.storage.local. Outbound fetches
// go through MSW's node interceptor; anything unmocked fails as a network error.
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, type ChromeMock } from "./chrome-mock";
// @ts-expect-error plain JS extension page, no types (D-13)
import { healthUrl, init, probeWords } from "../extension/options.js";

const WORKER = "https://satchel.example.workers.dev";
const HEALTH = `${WORKER}/health`;
const KEY = "test-satchel-key";

const server = setupServer(http.all("*", () => HttpResponse.error()));

// --- A fake DOM: just what options.js touches, with real state. ---

type Listener = (event: FakeEvent) => unknown;

class FakeEvent {
  defaultPrevented = false;
  constructor(
    public type: string,
    init: Partial<FakeEvent> = {},
  ) {
    Object.assign(this, init);
  }
  key?: string;
  metaKey = false;
  ctrlKey = false;
  altKey = false;
  repeat = false;
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeNode {
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  // Resolves when every listener's returned promise settles, so a test can await the work.
  async dispatch(event: FakeEvent) {
    await Promise.all((this.listeners.get(event.type) ?? []).map((fn) => fn(event)));
    return event;
  }
}

class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  private text = "";
  value = "";
  type = "";
  disabled = false;
  constructor(public tagName: string) {
    super();
  }
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this.text;
  }
  set textContent(value: string) {
    this.children = [];
    this.text = value;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.text = "";
    this.children = nodes;
  }
}

class FakeDocument extends FakeNode {
  activeElement: FakeElement | null;
  byId: Record<string, FakeElement>;
  constructor() {
    super();
    const key = new FakeElement("INPUT");
    key.type = "password";
    const show = new FakeElement("BUTTON");
    show.textContent = "Show";
    this.byId = {
      settings: new FakeElement("FORM"),
      "worker-url": new FakeElement("INPUT"),
      key,
      "show-key": show,
      save: new FakeElement("BUTTON"),
      test: new FakeElement("BUTTON"),
      status: new FakeElement("P"),
      results: new FakeElement("UL"),
    };
    this.activeElement = new FakeElement("BODY");
  }
  getElementById(id: string) {
    return this.byId[id] ?? null;
  }
  createElement(tag: string) {
    return new FakeElement(tag.toUpperCase());
  }
}

// --- Page helpers ---

let mock: ChromeMock;
let doc: FakeDocument;
let seen: { url: string; key: string | null }[];

const el = (id: string) => doc.byId[id]!;
const status = () => el("status").textContent;
const lines = () => el("results").children.map((li) => li.textContent);
const flagged = () => el("results").children.filter((li) => li.getAttribute("data-tone") === "error").map((li) => li.textContent);

async function open(storage: Record<string, unknown> = {}) {
  mock = createChromeMock(storage);
  vi.stubGlobal("chrome", mock.chrome);
  doc = new FakeDocument();
  await init(doc);
}

function type(id: string, value: string) {
  el(id).value = value;
}

// Enter in a field: the browser submits the form.
function pressEnter(field: string) {
  doc.activeElement = el(field);
  return el("settings").dispatch(new FakeEvent("submit"));
}

function pressKey(key: string, extra: Partial<FakeEvent> = {}) {
  return doc.dispatch(new FakeEvent("keydown", { key, ...extra }));
}

function clickTest() {
  return el("test").dispatch(new FakeEvent("click"));
}

function onHealth(reply: () => Response | Promise<Response>) {
  server.use(
    http.get(HEALTH, ({ request }) => {
      seen.push({ url: request.url, key: request.headers.get("x-satchel-key") });
      return reply();
    }),
  );
}

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
beforeEach(() => {
  seen = [];
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

describe("probe words", () => {
  it.each([
    ["ok", "ok"],
    ["auth_failed", "key rejected"],
    ["not_found", "not found"],
    ["error 0", "down"],
    ["error 503", "down (503)"],
    ["error 429", "down (429)"],
    [undefined, "no answer"],
    ["exploded", "no answer"],
  ])("%s reads as %s", (state, words) => {
    expect(probeWords(state)).toBe(words);
  });

  it("strips one trailing slash from the Worker URL", () => {
    expect(healthUrl(`${WORKER}/`)).toBe(HEALTH);
    expect(healthUrl(WORKER)).toBe(HEALTH);
  });
});

describe("settings", () => {
  it("fills the fields from chrome.storage.local", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    expect(el("worker-url").value).toBe(WORKER);
    expect(el("key").value).toBe(KEY);
  });

  it("Enter in a field saves both values, trimmed, to local storage and says Saved", async () => {
    await open();
    type("worker-url", `  ${WORKER}/ `);
    type("key", ` ${KEY}\n`);
    const event = await pressEnter("key");
    expect(event.defaultPrevented).toBe(true);
    expect(mock.storage).toEqual({ workerUrl: `${WORKER}/`, key: KEY });
    expect(status()).toBe("Saved.");
    expect(el("status").hasAttribute("data-tone")).toBe(false);
    // local only: the mock has no sync area, so a sync write would have thrown above.
    expect((mock.chrome as { storage: Record<string, unknown> }).storage.sync).toBeUndefined();
  });

  it("refuses a Worker URL that isn't one and leaves storage alone", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    type("worker-url", "satchel.example.workers.dev");
    await pressEnter("worker-url");
    expect(mock.storage).toEqual({ workerUrl: WORKER, key: KEY });
    expect(status()).toBe("The Worker URL should look like https://satchel.you.workers.dev");
    expect(el("status").getAttribute("data-tone")).toBe("error");
  });

  it("Show reveals the key and Hide masks it again", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    expect(el("key").type).toBe("password");
    await el("show-key").dispatch(new FakeEvent("click"));
    expect(el("key").type).toBe("text");
    expect(el("show-key").textContent).toBe("Hide");
    expect(el("show-key").getAttribute("aria-pressed")).toBe("true");
    await el("show-key").dispatch(new FakeEvent("click"));
    expect(el("key").type).toBe("password");
    expect(el("show-key").textContent).toBe("Show");
  });
});

describe("Test", () => {
  it("all ok: one line per probe, keyed GET to <workerUrl>/health", async () => {
    await open({ workerUrl: `${WORKER}/`, key: KEY });
    onHealth(() => HttpResponse.json({ ok: true, notion: "ok", claude: "ok", oembed: "ok" }));
    await clickTest();
    expect(seen).toEqual([{ url: HEALTH, key: KEY }]);
    expect(lines()).toEqual(["Notion: ok", "Claude: ok", "X oEmbed: ok"]);
    expect(flagged()).toEqual([]);
    expect(status()).toBe("");
  });

  it("a 503 names each failing probe in words and flags only those", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    onHealth(() =>
      HttpResponse.json({ ok: false, notion: "ok", claude: "auth_failed", oembed: "error 0" }, { status: 503 }),
    );
    await clickTest();
    expect(lines()).toEqual(["Notion: ok", "Claude: key rejected", "X oEmbed: down"]);
    expect(flagged()).toEqual(["Claude: key rejected", "X oEmbed: down"]);
  });

  it("not_found and an HTTP status read in words", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    onHealth(() =>
      HttpResponse.json({ ok: false, notion: "not_found", claude: "error 529", oembed: "ok" }, { status: 503 }),
    );
    await clickTest();
    expect(lines()).toEqual(["Notion: not found", "Claude: down (529)", "X oEmbed: ok"]);
  });

  it("a 401 says Key rejected", async () => {
    await open({ workerUrl: WORKER, key: "wrong-key" });
    onHealth(() => HttpResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    await clickTest();
    expect(seen).toEqual([{ url: HEALTH, key: "wrong-key" }]);
    expect(status()).toBe("Key rejected");
    expect(el("status").getAttribute("data-tone")).toBe("error");
    expect(lines()).toEqual([]);
  });

  it("a network error says Can't reach Worker", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    onHealth(() => HttpResponse.error());
    await clickTest();
    expect(status()).toBe("Can't reach Worker");
    expect(lines()).toEqual([]);
  });

  it("a non-JSON answer says Unexpected response with the status", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    onHealth(() => new HttpResponse("<html>gateway</html>", { status: 502 }));
    await clickTest();
    expect(status()).toBe("Unexpected response (502)");
  });

  it("tests what's in the fields, before Save", async () => {
    await open({ workerUrl: "https://old.example.workers.dev", key: "old-key" });
    type("worker-url", WORKER);
    type("key", KEY);
    onHealth(() => HttpResponse.json({ ok: true, notion: "ok", claude: "ok", oembed: "ok" }));
    await clickTest();
    expect(seen).toEqual([{ url: HEALTH, key: KEY }]);
    expect(mock.storage).toEqual({ workerUrl: "https://old.example.workers.dev", key: "old-key" });
  });

  it("with an empty field, asks for both and calls nothing", async () => {
    await open({ workerUrl: WORKER });
    await clickTest();
    expect(seen).toEqual([]);
    expect(status()).toBe("Add the Worker URL and Satchel key first.");
  });

  it("a new Test clears the last result", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    onHealth(() => HttpResponse.json({ ok: true, notion: "ok", claude: "ok", oembed: "ok" }));
    await clickTest();
    server.resetHandlers();
    onHealth(() => HttpResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    await clickTest();
    expect(lines()).toEqual([]);
    expect(status()).toBe("Key rejected");
  });
});

describe("keyboard", () => {
  beforeEach(() => {
    onHealth(() => HttpResponse.json({ ok: true, notion: "ok", claude: "ok", oembed: "ok" }));
  });

  it("T with no field focused runs Test", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    doc.activeElement = el("save"); // a button isn't a field
    const event = await pressKey("t");
    expect(event.defaultPrevented).toBe(true);
    expect(lines()).toEqual(["Notion: ok", "Claude: ok", "X oEmbed: ok"]);
  });

  it("T typed into a field is just a letter", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    doc.activeElement = el("key");
    const event = await pressKey("T");
    expect(event.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
    expect(lines()).toEqual([]);
  });

  it("Cmd+T and a held T don't run Test", async () => {
    await open({ workerUrl: WORKER, key: KEY });
    await pressKey("t", { metaKey: true });
    await pressKey("t", { repeat: true });
    expect(seen).toEqual([]);
  });
});
