// extension/popup.js under the extension (node) Vitest project.
//
// The repo has no DOM library and the extension takes no dependency (D-13), so this file
// parses the real extension/popup.html into a small element tree and gives popup.js the
// handful of DOM APIs it uses. Tests drive it the way a person would (keys and clicks)
// and assert on what reached the service worker and on the DOM that's left.
//
// chrome.storage comes from test/chrome-mock.ts. The popup side of chrome.runtime
// (sendMessage, connect, openOptionsPage) and chrome.tabs aren't in that mock, so they're
// added here: sendMessage records each message and hands the test its reply to resolve.
// SAT-58: chrome.scripting.executeScript runs popup.js's real injected function against a
// page parsed from a fixture with the same small DOM, so tests check what it reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock } from "./chrome-mock";
import popupHtml from "../extension/popup.html?raw";
import popupCss from "../extension/popup.css?raw";

// ---------- a small DOM, parsed from popup.html ----------

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  type: string;
  key?: string;
  target: FakeElement | null;
  defaultPrevented: boolean;
  preventDefault(): void;
  [extra: string]: unknown;
}

function makeEvent(type: string, target: FakeElement | null, extra: Record<string, unknown> = {}): FakeEvent {
  return {
    type,
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  };
}

class FakeText {
  constructor(public text: string) {}
}

class FakeElement {
  attrs = new Map<string, string>();
  children: (FakeElement | FakeText)[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, Listener[]>();

  constructor(
    public tagName: string,
    public doc: FakeDocument,
  ) {}

  get id() {
    return this.attrs.get("id") ?? "";
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: unknown) {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }

  get hidden() {
    return this.attrs.has("hidden");
  }
  set hidden(on: boolean) {
    if (on) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
    if (on && this.doc.activeElement && !this.doc.activeElement.rendered) this.doc.activeElement = null;
  }
  get disabled() {
    return this.attrs.has("disabled");
  }
  set disabled(on: boolean) {
    if (on) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
    // A browser drops focus from a control that becomes disabled.
    if (on && this.doc.activeElement === this) this.doc.activeElement = null;
  }
  // Shown: neither it nor any ancestor has the hidden attribute.
  get rendered(): boolean {
    return !this.hidden && (this.parent ? this.parent.rendered : true);
  }

  get classList() {
    const read = () => (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const write = (list: string[]) => this.setAttribute("class", list.join(" "));
    return {
      add: (...names: string[]) => write([...read(), ...names.filter((n) => !read().includes(n))]),
      remove: (...names: string[]) => write(read().filter((n) => !names.includes(n))),
      contains: (name: string) => read().includes(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !read().includes(name);
        write(on ? [...read().filter((n) => n !== name), name] : read().filter((n) => n !== name));
        return on;
      },
    };
  }
  hasClass(name: string) {
    return this.classList.contains(name);
  }

  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join("");
  }
  set textContent(value: string) {
    this.children = value ? [new FakeText(String(value))] : [];
  }
  // Rendered text, whitespace collapsed, hidden descendants left out.
  get visibleText(): string {
    if (this.hidden) return "";
    return this.children
      .map((c) => (c instanceof FakeText ? c.text : c.visibleText))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click() {
    // A disabled control, or one that isn't on screen, can't be clicked.
    if (this.disabled || !this.rendered) return;
    for (const fn of this.listeners.get("click") ?? []) fn(makeEvent("click", this));
  }
  focus() {
    if (this.disabled || !this.rendered || this.doc.activeElement === this) return;
    this.doc.activeElement = this;
    for (const fn of this.listeners.get("focus") ?? []) fn(makeEvent("focus", this));
  }
  hover() {
    if (!this.rendered) return;
    for (const fn of this.listeners.get("pointerenter") ?? []) fn(makeEvent("pointerenter", this));
  }
  // Descendants matching `tag` or `tag[attr="value"]`, in document order: all the injected
  // preview read (SAT-58) asks of a page.
  querySelectorAll(selector: string): FakeElement[] {
    const m = /^([a-z][\w-]*)(?:\[([\w:-]+)="([^"]*)"\])?$/i.exec(selector);
    if (!m) throw new Error(`unsupported selector: ${selector}`);
    const [, tag, attr, value] = m;
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const c of el.children) {
        if (!(c instanceof FakeElement)) continue;
        if (c.tagName === tag!.toLowerCase() && (attr === undefined || c.getAttribute(attr) === value)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  find(id: string): FakeElement | null {
    if (this.id === id) return this;
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        const hit = c.find(id);
        if (hit) return hit;
      }
    }
    return null;
  }
}

class FakeDocument {
  root: FakeElement;
  activeElement: FakeElement | null = null;
  listeners = new Map<string, Listener[]>();

  constructor(
    html: string,
    public baseURI = "chrome-extension://satchel/popup.html",
  ) {
    this.root = parseHtml(html, this);
  }
  querySelector(selector: string) {
    return this.root.querySelectorAll(selector)[0] ?? null;
  }
  get body() {
    return this.querySelector("body");
  }
  getElementById(id: string) {
    return this.root.find(id);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
}

const VOID_TAGS = new Set(["meta", "link", "br", "img", "input", "hr"]);
const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Strict on purpose: a close tag that doesn't match the open element throws, so a
// malformed popup.html fails here rather than rendering oddly in Chrome.
function parseHtml(html: string, doc: FakeDocument): FakeElement {
  const root = new FakeElement("#document", doc);
  let current = root;
  const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
  for (const m of html.matchAll(token)) {
    const [, close, open, attrs, selfClose, text] = m;
    if (close) {
      if (current.tagName !== close.toLowerCase()) throw new Error(`popup.html: </${close}> closes <${current.tagName}>`);
      current = current.parent!;
    } else if (open) {
      const el = new FakeElement(open.toLowerCase(), doc);
      for (const a of (attrs ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) el.attrs.set(a[1]!, decode(a[2] ?? ""));
      el.parent = current;
      current.children.push(el);
      if (!VOID_TAGS.has(el.tagName) && !selfClose) current = el;
    } else if (text) {
      current.children.push(new FakeText(decode(text)));
    }
  }
  if (current !== root) throw new Error(`popup.html: <${current.tagName}> never closed`);
  return root;
}

// ---------- the popup's world ----------

const WORKER = "https://satchel.example.workers.dev";
const KEY = "test-satchel-key";
const TAB = {
  id: 42,
  url: "https://www.lennysnewsletter.com/p/how-linear-builds-product",
  title: "How Linear Builds Product",
};
// The tab's page by default: no preview tags and no long paragraph, so the read finds nothing
// and saves carry only url, title and status, as before SAT-58.
const BARE_PAGE = "<html><head><title>A page</title></head><body><p>Short.</p></body></html>";

type Injection = { target: { tabId: number }; func: (...args: unknown[]) => unknown; args?: unknown[] };

interface Pending {
  message: Record<string, unknown>;
  resolve(reply: unknown): void;
  reject(err: Error): void;
}

interface FakePort {
  name: string;
  disconnected: boolean;
  listeners: (() => void)[];
  onDisconnect: { addListener(fn: () => void): void };
  disconnect(): void;
  drop(): void; // the service worker going away
}

let doc: FakeDocument;
let sent: Pending[];
let ports: FakePort[];
let closedAt: number | null;
let optionsOpened: number;
let openedAt: number;
let injections: Injection[];

const $ = (id: string) => {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`no #${id} in popup.html`);
  return el;
};
const messages = () => sent.map((p) => p.message);
const statuses = () => sent.map((p) => p.message.status);
const elapsed = () => (closedAt === null ? null : closedAt - openedAt);
const flush = () => vi.advanceTimersByTimeAsync(0);
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
// popup.js's timings (SAT-47). The boundary tests below use literal times, so a change fails them.
const FAVORITE_WINDOW_MS = 3000; // the favorite window after R
const CLOSE_AFTER_MS = 600; // a good reply to close

async function reply(index: number, value: unknown) {
  sent[index]!.resolve(value);
  await flush();
}

// A key the way Chrome delivers it: keydown to the document, then the default action
// (Enter or Space on a focused button or link clicks it) unless a handler prevented it.
async function press(key: string, extra: Record<string, unknown> = {}) {
  const target = doc.activeElement;
  const event = makeEvent("keydown", target, { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra });
  for (const fn of doc.listeners.get("keydown") ?? []) fn(event);
  if (!event.defaultPrevented && (key === "Enter" || key === " ") && target && ["button", "a"].includes(target.tagName)) {
    target.click();
  }
  await flush();
}

async function click(id: string) {
  $(id).click();
  await flush();
}

// Runs the injected function the way Chrome does: in the page (here, `document` swapped for
// the page's), with its result structured-cloned back in a one-frame results array.
function runInPage(pageHtml: string, url: string) {
  return async (injection: Injection) => {
    injections.push(injection);
    const page = new FakeDocument(pageHtml, url);
    const popupDoc = (globalThis as any).document;
    (globalThis as any).document = page;
    try {
      const result = injection.func(...(injection.args ?? []));
      return [{ frameId: 0, documentId: "page-doc", result: JSON.parse(JSON.stringify(result ?? null)) }];
    } finally {
      (globalThis as any).document = popupDoc;
    }
  };
}

async function open({
  storage = { workerUrl: WORKER, key: KEY } as Record<string, unknown>,
  tab = TAB as { id?: number; url?: string; title?: string },
  reducedMotion = false,
  pageHtml = BARE_PAGE,
  // undefined: run the real read against pageHtml; null: no chrome.scripting at all.
  executeScript = undefined as ((injection: Injection) => unknown) | null | undefined,
} = {}) {
  doc = new FakeDocument(popupHtml as string);
  sent = [];
  ports = [];
  closedAt = null;
  optionsOpened = 0;
  injections = [];

  const mock = createChromeMock(storage);
  const chrome = mock.chrome as any;
  chrome.runtime.lastError = undefined;
  chrome.runtime.sendMessage = (message: Record<string, unknown>) =>
    new Promise((resolve, reject) => sent.push({ message, resolve, reject }));
  chrome.runtime.connect = ({ name }: { name: string }) => {
    const listeners: (() => void)[] = [];
    const port: FakePort = {
      name,
      disconnected: false,
      listeners,
      onDisconnect: { addListener: (fn) => listeners.push(fn) },
      disconnect() {
        port.disconnected = true; // Chrome doesn't fire onDisconnect on the side that disconnects
      },
      drop() {
        port.disconnected = true;
        for (const fn of listeners) fn();
      },
    };
    ports.push(port);
    return port;
  };
  chrome.runtime.openOptionsPage = async () => {
    optionsOpened += 1;
  };
  chrome.tabs = {
    async query(q: unknown) {
      expect(q).toEqual({ active: true, currentWindow: true });
      return [tab];
    },
  };
  if (executeScript !== null) chrome.scripting = { executeScript: executeScript ?? runInPage(pageHtml, tab.url ?? "") };

  vi.stubGlobal("chrome", chrome);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    close() {
      closedAt ??= Date.now();
    },
    matchMedia: (query: string) => ({ matches: reducedMotion && query === "(prefers-reduced-motion: reduce)" }),
  });
  vi.resetModules();
  // @ts-expect-error plain JS popup, no types (D-13)
  await import("../extension/popup.js");
  await flush();
  openedAt = Date.now();
}

// Time since open() finished, for close timings. Reset at the moment that matters.
const markNow = () => (openedAt = Date.now());

const isShown = (id: string) => $(id).rendered;
const keycapFilled = (status: string) => $(`row-${status}`).hasClass("is-active");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const save = (status: string) => ({ type: "save", url: TAB.url, title: TAB.title, status });

// ---------- at rest ----------

describe("at rest", () => {
  it("shows the domain, the title, two rows with keycaps, and the footer", async () => {
    await open();
    expect($("popup").getAttribute("data-state")).toBe("rest");
    expect($("domain").textContent).toBe("lennysnewsletter.com");
    expect($("title").textContent).toBe(TAB.title);
    expect($("row-later").visibleText).toBe("Send to inbox L");
    expect($("row-read").visibleText).toBe("Mark as archived R");
    expect(isShown("row-favorite")).toBe(false);
    expect(isShown("setup")).toBe(false);
    expect($("close").parent!.visibleText).toBe("esc close");
    expect($("popup").visibleText).not.toContain("?");
    expect(doc.activeElement).toBe($("row-later"));
    expect(sent).toEqual([]);
  });

  it("holds a popup port while open and reconnects it 250 ms after it drops", async () => {
    await open();
    expect(ports.map((p) => [p.name, p.disconnected])).toEqual([["popup", false]]);
    ports[0]!.drop(); // an idle worker shut down
    await wait(249);
    expect(ports).toHaveLength(1);
    await wait(1);
    expect(ports.map((p) => [p.name, p.disconnected])).toEqual([
      ["popup", true],
      ["popup", false],
    ]);
  });

  it("backs off to 1 s between reconnects when the port keeps dropping, so a broken worker can't spin", async () => {
    await open();
    const connectedAt: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = ports.length;
      ports[ports.length - 1]!.drop(); // drops as soon as it connects
      const dropped = Date.now();
      while (ports.length === before) await wait(1);
      connectedAt.push(Date.now() - dropped);
    }
    expect(connectedAt).toEqual([250, 1000, 1000, 1000]);
  });

  it("goes back to the short delay after a port has held for a while", async () => {
    await open();
    ports[0]!.drop();
    await wait(250);
    ports[1]!.drop();
    await wait(1000);
    expect(ports).toHaveLength(3);
    await wait(30_000); // this one lived (the worker idled out normally)
    ports[2]!.drop();
    await wait(250);
    expect(ports).toHaveLength(4);
  });

  it("a connect that throws is retried with the same backoff", async () => {
    await open();
    const runtime = (globalThis as any).chrome.runtime;
    const realConnect = runtime.connect;
    let attempts = 0;
    runtime.connect = () => {
      attempts += 1;
      throw new Error("Extension context invalidated.");
    };
    ports[0]!.drop();
    await wait(250 + 1000 + 1000);
    expect(attempts).toBe(3);
    runtime.connect = realConnect;
    await wait(1000);
    expect(ports.map((p) => p.disconnected)).toEqual([true, false]);
  });

  it("lets go of the port on close and doesn't reconnect", async () => {
    await open();
    await press("Escape");
    expect(closedAt).not.toBeNull();
    expect(ports.map((p) => p.disconnected)).toEqual([true]);
    ports[0]!.drop();
    await wait(5000);
    expect(ports).toHaveLength(1);
  });

  it("esc closes at once and sends nothing", async () => {
    await open();
    await press("Escape");
    expect(elapsed()).toBe(0);
    expect(sent).toEqual([]);
  });

  for (const [name, tab] of [
    ["Chrome's untitled-page title (the URL without its scheme)", { url: "https://notes.example.com/drafts/q3-plan", title: "notes.example.com/drafts/q3-plan" }],
    ["a title that is the whole URL", { url: "https://example.com/report.pdf", title: "https://example.com/report.pdf" }],
    ["an image tab's name.ext (W×H)", { url: "https://i.example.com/a1b2c3.png", title: "a1b2c3.png (1200×800)" }],
  ] as const) {
    it(`doesn't send ${name} as the title, but still shows it`, async () => {
      await open({ tab });
      expect($("title").textContent).toBe(tab.title);
      await press("l");
      expect(messages()).toEqual([{ type: "save", url: tab.url, status: "later" }]);
    });
  }

  it("sends a real title that happens to mention the domain", async () => {
    const tab = { url: "https://example.com/", title: "example.com: Example Domain" };
    await open({ tab });
    await press("l");
    expect(messages()).toEqual([{ type: "save", url: tab.url, title: tab.title, status: "later" }]);
  });

  it("leaves the title out of the message when the tab has none, and shows the URL", async () => {
    await open({ tab: { url: "https://example.com/x" } });
    expect($("title").textContent).toBe("https://example.com/x");
    await press("l");
    expect(messages()).toEqual([{ type: "save", url: "https://example.com/x", status: "later" }]);
  });

  it("shows the site name, without www., for an https tab", async () => {
    await open({ tab: { url: "https://www.example.com/x", title: "X" } });
    expect($("domain").textContent).toBe("example.com");
  });

  it.each([
    ["chrome://", "chrome://extensions/"],
    ["chrome-extension://", "chrome-extension://mgmdmpjmkmljmpnjgmnoipngeckphfpo/options.html"],
    ["file://", "file:///Users/me/notes.html"],
    ["about:", "about:blank"],
  ])("shows no domain on a %s tab, just the title", async (_scheme, url) => {
    await open({ tab: { url, title: "Some Page" } });
    expect($("popup").getAttribute("data-state")).toBe("rest");
    expect($("domain").textContent).toBe("");
    expect($("title").textContent).toBe("Some Page");
  });
});

// ---------- L: send to inbox ----------

describe("L sends later", () => {
  it("sends {type: save, url, title, status: later}, fills the L keycap, stamps on ok and closes 600 ms after the reply", async () => {
    await open();
    await press("l");
    expect(messages()).toEqual([save("later")]);
    expect(keycapFilled("later")).toBe(true);
    expect(isShown("stamp-later")).toBe(false); // nothing claims SAVED before the reply

    await wait(500); // a slow Worker
    expect(isShown("stamp-later")).toBe(false);
    await reply(0, { ok: true, id: "page-1" });
    markNow();
    expect(isShown("stamp-later")).toBe(true);
    expect($("row-later").hasClass("is-saved")).toBe(true);
    expect($("status").textContent).toBe("Saved");
    expect($("close").parent!.visibleText).toBe("esc close"); // no timing copy
    expect($("row-read").disabled).toBe(true);

    await wait(CLOSE_AFTER_MS - 1);
    expect(closedAt).toBeNull();
    await wait(1);
    expect(elapsed()).toBe(CLOSE_AFTER_MS);
  });

  it("holds SAVED a beat: still open at 550 ms after the reply, closed by 650 ms", async () => {
    await open();
    await press("l");
    await reply(0, { ok: true, id: "page-1" });
    await wait(550);
    expect(closedAt).toBeNull();
    expect($("popup").getAttribute("data-state")).toBe("saved");
    expect(isShown("stamp-later")).toBe(true);
    await wait(100);
    expect(closedAt).not.toBeNull();
  });

  it("a capital L works too", async () => {
    await open();
    await press("L", { shiftKey: true });
    expect(statuses()).toEqual(["later"]);
  });

  it("clicking the row does the same", async () => {
    await open();
    await click("row-later");
    expect(messages()).toEqual([save("later")]);
  });

  it("with reduced motion, shows the stamp and closes at the same moment", async () => {
    await open({ reducedMotion: true });
    await press("l");
    await reply(0, { ok: true, id: "page-1" });
    expect(isShown("stamp-later")).toBe(true);
    expect(closedAt).not.toBeNull();
  });
});

// ---------- R, then F ----------

describe("R sends read and offers Favorite", () => {
  it("sends read at once, fills R, dims L and shows the Favorite row with F", async () => {
    await open();
    await press("r");
    expect(messages()).toEqual([save("read")]); // before any reply
    expect(keycapFilled("read")).toBe(true);
    expect($("row-later").disabled).toBe(true);
    expect(isShown("row-favorite")).toBe(true);
    expect($("row-favorite").disabled).toBe(false);
    expect($("row-favorite").visibleText).toBe("Favorite F");
    expect($("close").parent!.visibleText).toBe("esc close"); // no how-it-works copy
  });

  it("F within the window sends favorite after read, then stamps the Favorite row once both replies are ok", async () => {
    await open();
    await press("r");
    await wait(FAVORITE_WINDOW_MS - 100);
    await press("f");
    expect(statuses()).toEqual(["read", "favorite"]);
    expect(messages()[1]).toEqual(save("favorite"));
    expect(keycapFilled("favorite")).toBe(true);

    await reply(1, { ok: true, id: "page-1" }); // favorite's reply alone isn't enough
    expect(isShown("stamp-favorite")).toBe(false);
    await reply(0, { ok: true, id: "page-1" });
    markNow();
    expect(isShown("stamp-favorite")).toBe(true);
    expect(isShown("stamp-read")).toBe(false);
    await wait(CLOSE_AFTER_MS);
    expect(elapsed()).toBe(CLOSE_AFTER_MS);
  });

  it("the window ending closes: no F, the read's stamp, then close", async () => {
    await open();
    await press("r");
    await reply(0, { ok: true, id: "page-1" });
    await wait(FAVORITE_WINDOW_MS - 1);
    expect(isShown("row-favorite")).toBe(true);
    expect(isShown("stamp-read")).toBe(false);
    expect(closedAt).toBeNull();

    await wait(1);
    markNow();
    expect(isShown("row-favorite")).toBe(false);
    expect(isShown("stamp-read")).toBe(true);
    await wait(CLOSE_AFTER_MS);
    expect(elapsed()).toBe(CLOSE_AFTER_MS);
    expect(statuses()).toEqual(["read"]);
  });

  it("F after the window has closed sends nothing", async () => {
    await open();
    await press("r");
    await reply(0, { ok: true, id: "page-1" });
    await wait(FAVORITE_WINDOW_MS);
    await press("f");
    expect(statuses()).toEqual(["read"]);
  });

  // SAT-47: the window is 3 s. Literal times here, so a change to the window fails this.
  it("F at 2.9 s still favorites", async () => {
    await open();
    await press("r");
    await reply(0, { ok: true, id: "page-1" });
    await wait(2900);
    expect($("popup").getAttribute("data-state")).toBe("window");
    expect(isShown("row-favorite")).toBe(true);
    await press("f");
    expect(statuses()).toEqual(["read", "favorite"]);
    await reply(1, { ok: true, id: "page-1" });
    expect(isShown("stamp-favorite")).toBe(true);
  });

  it("by 3.1 s the window has ended: Favorite gone, F sends nothing", async () => {
    await open();
    await press("r");
    await reply(0, { ok: true, id: "page-1" });
    await wait(3100);
    expect($("popup").getAttribute("data-state")).not.toBe("window");
    expect(isShown("row-favorite")).toBe(false);
    expect(isShown("stamp-read")).toBe(true);
    await press("f");
    expect(statuses()).toEqual(["read"]);
  });

  it("never shows SAVED before the read reply is ok", async () => {
    await open();
    await press("r");
    await wait(FAVORITE_WINDOW_MS); // window over, read still in flight
    expect(isShown("row-favorite")).toBe(false);
    expect(isShown("stamp-read")).toBe(false);
    await wait(3000);
    expect(isShown("stamp-read")).toBe(false);
    expect(closedAt).toBeNull();

    await reply(0, { ok: true, id: "page-1" });
    markNow();
    expect(isShown("stamp-read")).toBe(true);
    await wait(CLOSE_AFTER_MS);
    expect(elapsed()).toBe(CLOSE_AFTER_MS);
  });

  for (const [name, key] of [
    ["esc", "Escape"],
    ["Enter", "Enter"],
    ["any other key", "x"],
  ] as const) {
    it(`${name} during the window ends it: the read's stamp, then close`, async () => {
      await open();
      await press("r");
      await reply(0, { ok: true, id: "page-1" });
      await press(key);
      markNow();
      expect(isShown("row-favorite")).toBe(false);
      expect(isShown("stamp-read")).toBe(true);
      await wait(CLOSE_AFTER_MS);
      expect(elapsed()).toBe(CLOSE_AFTER_MS);
      expect(statuses()).toEqual(["read"]);
    });
  }

  it("Shift alone doesn't end the window", async () => {
    await open();
    await press("r");
    await press("Shift", { shiftKey: true });
    expect(isShown("row-favorite")).toBe(true);
  });

  it("clicking Favorite during the window sends favorite", async () => {
    await open();
    await press("r");
    await click("row-favorite");
    expect(statuses()).toEqual(["read", "favorite"]);
  });
});

// ---------- failure ----------

describe("failure", () => {
  it("keeps the popup open with the error in ink under the row, and L retries", async () => {
    await open();
    await press("l");
    await reply(0, { ok: false, error: "notion_rate_limited" });
    await wait(5000);
    expect(closedAt).toBeNull();
    expect($("popup").getAttribute("data-state")).toBe("error");
    expect($("label-later").textContent).toBe("Couldn't save, try again");
    expect($("detail-later").textContent).toBe("notion_rate_limited");
    expect(isShown("detail-later")).toBe(true);
    expect($("row-later").hasClass("is-error")).toBe(true);
    expect(keycapFilled("later")).toBe(false);
    expect(isShown("stamp-later")).toBe(false);
    expect($("row-later").disabled).toBe(false);
    expect($("row-read").disabled).toBe(false);

    await press("l");
    expect(statuses()).toEqual(["later", "later"]);
    expect($("label-later").textContent).toBe("Send to inbox");
    expect(isShown("detail-later")).toBe(false);
    await reply(1, { ok: true, id: "page-1" });
    expect(isShown("stamp-later")).toBe(true);
  });

  it("no reply (the message channel closed) is a failure too", async () => {
    await open();
    await press("l");
    sent[0]!.reject(new Error("The message port closed before a response was received."));
    await flush();
    expect($("label-later").textContent).toBe("Couldn't save, try again");
    expect($("detail-later").textContent).toBe("no reply");
    expect(closedAt).toBeNull();
  });

  it("a failed read ends the Favorite window early and shows the error; R retries", async () => {
    await open();
    await press("r");
    await reply(0, { ok: false, error: "unauthorized" });
    expect(isShown("row-favorite")).toBe(false);
    expect($("label-read").textContent).toBe("Couldn't save, try again");
    expect($("detail-read").textContent).toBe("unauthorized");
    await wait(5000);
    expect(closedAt).toBeNull();

    await press("r");
    expect(statuses()).toEqual(["read", "read"]);
    expect(isShown("row-favorite")).toBe(true);
  });

  it("a read that fails after the window closed shows the error, never the stamp", async () => {
    await open();
    await press("r");
    await wait(FAVORITE_WINDOW_MS);
    await reply(0, { ok: false, error: "notion_conflict" });
    expect(isShown("stamp-read")).toBe(false);
    expect($("detail-read").textContent).toBe("notion_conflict");
    expect(closedAt).toBeNull();
  });

  it("a failed favorite shows on the Favorite row, and F retries it", async () => {
    await open();
    await press("r");
    await press("f");
    await reply(0, { ok: true, id: "page-1" });
    await reply(1, { ok: false, error: "notion_unavailable" });
    expect(isShown("row-favorite")).toBe(true);
    expect($("label-favorite").textContent).toBe("Couldn't save, try again");
    expect($("detail-favorite").textContent).toBe("notion_unavailable");
    expect(isShown("stamp-favorite")).toBe(false);

    await press("f");
    expect(statuses()).toEqual(["read", "favorite", "favorite"]);
    await reply(2, { ok: true, id: "page-1" });
    expect(isShown("stamp-favorite")).toBe(true);
  });
});

// ---------- setup ----------

describe("missing setup", () => {
  for (const [name, storage] of [
    ["nothing stored", {}],
    ["no key", { workerUrl: WORKER }],
    ["no Worker URL", { key: KEY }],
  ] as const) {
    it(`${name}: shows Set up Satchel with S instead of the rows`, async () => {
      await open({ storage: { ...storage } });
      expect($("popup").getAttribute("data-state")).toBe("setup");
      expect(isShown("rows")).toBe(false);
      expect(isShown("setup")).toBe(true);
      expect($("setup-link").visibleText).toBe("Set up Satchel S");
      expect($("setup-link").getAttribute("href")).toBe("options.html");
      expect(doc.activeElement).toBe($("setup-link"));
    });
  }

  it("L and R send nothing; S opens the options page and closes", async () => {
    await open({ storage: {} });
    await press("l");
    await press("r");
    expect(sent).toEqual([]);
    await press("s");
    expect(optionsOpened).toBe(1);
    expect(closedAt).not.toBeNull();
  });

  it("clicking the link opens the options page", async () => {
    await open({ storage: {} });
    await click("setup-link");
    expect(optionsOpened).toBe(1);
    expect(closedAt).not.toBeNull();
  });
});

// ---------- no double saves ----------

describe("double presses send once", () => {
  it("L, L and a click on L send one later", async () => {
    await open();
    await press("l");
    await press("l");
    await click("row-later");
    await press("Enter");
    expect(statuses()).toEqual(["later"]);
  });

  it("R twice sends one read (the second R just ends the window)", async () => {
    await open();
    await press("r");
    await press("r");
    await click("row-read");
    expect(statuses()).toEqual(["read"]);
  });

  it("F twice sends one favorite", async () => {
    await open();
    await press("r");
    await press("f");
    await press("f");
    await click("row-favorite");
    expect(statuses()).toEqual(["read", "favorite"]);
  });

  it("L then R sends only the later", async () => {
    await open();
    await press("l");
    await press("r");
    expect(statuses()).toEqual(["later"]);
  });
});

// ---------- keyboard model ----------

// The rows that look selected: the wash comes from .is-current, or :focus-visible on the
// focused row. Counting both is the strict reading.
const washed = () =>
  ["later", "read", "favorite"]
    .map((s) => $(`row-${s}`))
    .filter((r) => r.rendered && (r.hasClass("is-current") || doc.activeElement === r))
    .map((r) => r.id);

describe("one row looks selected", () => {
  it("at rest it's L", async () => {
    await open();
    expect(washed()).toEqual(["row-later"]);
  });

  it("after a failed L, ArrowDown leaves exactly one row washed (R)", async () => {
    await open();
    await press("l");
    await reply(0, { ok: false, error: "notion_rate_limited" });
    expect(washed()).toEqual(["row-later"]);
    await press("ArrowDown");
    expect(washed()).toEqual(["row-read"]);
    await press("Enter");
    expect(statuses()).toEqual(["later", "read"]);
  });

  it("hovering a row moves the selection to it, so Enter activates the row that looks selected", async () => {
    await open();
    $("row-read").hover();
    expect(washed()).toEqual(["row-read"]);
    expect(doc.activeElement).toBe($("row-read"));
    await press("Enter");
    expect(statuses()).toEqual(["read"]);
  });

  it("after R it's the Favorite row only", async () => {
    await open();
    await press("r");
    expect(washed()).toEqual(["row-favorite"]);
  });

  it("hovering a disabled row doesn't take the selection", async () => {
    await open();
    await press("r");
    $("row-later").hover();
    expect(washed()).toEqual(["row-favorite"]);
  });

  it("when saved it's the stamped row only", async () => {
    await open();
    $("row-read").hover();
    await press("l");
    await reply(0, { ok: true, id: "page-1" });
    expect(washed()).toEqual(["row-later"]);
  });
});

describe("held keys", () => {
  it("holding R sends one read and doesn't end the Favorite window", async () => {
    await open();
    await press("r");
    for (let i = 0; i < 10; i++) await press("r", { repeat: true });
    expect(statuses()).toEqual(["read"]);
    expect(isShown("row-favorite")).toBe(true);
    expect($("popup").getAttribute("data-state")).toBe("window");
    await press("f");
    expect(statuses()).toEqual(["read", "favorite"]);
  });

  it("holding Enter on the focused Favorite row never favorites", async () => {
    await open();
    await press("r");
    await reply(0, { ok: true, id: "page-1" });
    await press("Enter");
    await press("Enter", { repeat: true });
    expect(statuses()).toEqual(["read"]);
  });

  it("holding L sends one later", async () => {
    await open();
    await press("l");
    await press("l", { repeat: true });
    expect(statuses()).toEqual(["later"]);
  });
});

describe("keys", () => {
  it("? does nothing: no key sheet, nothing sent, nothing closed", async () => {
    await open();
    const footer = $("close").parent!.visibleText;
    await press("?", { shiftKey: true });
    expect($("popup").getAttribute("data-state")).toBe("rest");
    expect($("close").parent!.visibleText).toBe(footer);
    expect(doc.getElementById("keys")).toBeNull();
    expect(sent).toEqual([]);
    expect(closedAt).toBeNull();
  });

  it("arrow keys move focus between the rows and Enter activates once", async () => {
    await open();
    await press("ArrowDown");
    expect(doc.activeElement).toBe($("row-read"));
    await press("ArrowDown");
    expect(doc.activeElement).toBe($("row-later")); // wraps
    await press("ArrowUp");
    expect(doc.activeElement).toBe($("row-read"));
    await press("Enter");
    expect(statuses()).toEqual(["read"]);
  });

  it("Space on a focused row activates it once", async () => {
    await open();
    await press(" ");
    expect(statuses()).toEqual(["later"]);
  });

  it("browser shortcuts with a modifier are left alone", async () => {
    await open();
    await press("r", { metaKey: true });
    await press("l", { ctrlKey: true });
    expect(sent).toEqual([]);
  });
});

// ---------- popup.css rule 8 ----------

describe("popup.css", () => {
  it("has no raw hex color and no px font size", () => {
    const css = (popupCss as string).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css.match(/#[0-9a-f]{3,8}\b/gi)).toBeNull();
    expect(css.match(/font-size:\s*[\d.]+px/gi)).toBeNull();
  });
});

// ---------- SAT-58: the tab's preview rides along with the save ----------

describe("SAT-58: the save carries the tab's preview", () => {
  const COVER = "https://substackcdn.com/image/fetch/w_1200,h_600,c_fill/cover.png";
  const LONG =
    "Special thanks to the many people who reviewed this post. One of the most interesting questions is how to keep the base layer simple.";
  const page = (head: string, body = "") => `<html><head><title>A page</title>${head}</head><body>${body}</body></html>`;

  it("a Substack post: og:image and og:description from the tab go with L", async () => {
    await open({
      pageHtml: page(
        `<meta property="og:image" content="${COVER}">` +
          '<meta name="twitter:image" content="https://substackcdn.com/twitter.png">' +
          '<meta property="og:description" content="How Linear plans,\n   builds and ships.">',
      ),
    });
    expect(injections.map((i) => i.target)).toEqual([{ tabId: 42 }]);
    await press("l");
    expect(messages()).toEqual([{ ...save("later"), image: COVER, description: "How Linear plans, builds and ships." }]);
  });

  it("R and then F both carry it", async () => {
    await open({ pageHtml: page(`<meta property="og:image" content="${COVER}">`) });
    await press("r");
    await press("f");
    expect(messages()).toEqual([
      { ...save("read"), image: COVER },
      { ...save("favorite"), image: COVER },
    ]);
  });

  it("a relative og:image is made absolute against the page URL", async () => {
    await open({ pageHtml: page('<meta property="og:image" content="/img/cover.png?w=1200&amp;h=630">') });
    await press("l");
    expect(messages()[0]!.image).toBe("https://www.lennysnewsletter.com/img/cover.png?w=1200&h=630");
  });

  it("an http: og:image is skipped for the https twitter:image", async () => {
    await open({
      pageHtml: page(
        '<meta property="og:image" content="http://cdn.example.com/a.png">' +
          '<meta property="twitter:image" content="https://cdn.example.com/b.png">',
      ),
    });
    await press("l");
    expect(messages()[0]!.image).toBe("https://cdn.example.com/b.png");
  });

  it.each([
    ["only an http: image", '<meta property="og:image" content="http://cdn.example.com/a.png">'],
    ["a data: URL", '<meta property="og:image" content="data:image/png;base64,iVBORw0KGgo=">'],
    ["an image over 2000 characters", `<meta property="og:image" content="https://cdn.example.com/${"a".repeat(2000)}.png">`],
  ])("%s: no image in the message", async (_name, head) => {
    await open({ pageHtml: page(head) });
    await press("l");
    expect(messages()).toEqual([save("later")]);
  });

  it("no og:description: the meta description", async () => {
    await open({ pageHtml: page('<meta name="description" content="The meta one.">', `<article><p>${LONG}</p></article>`) });
    await press("l");
    expect(messages()[0]!.description).toBe("The meta one.");
  });

  it("no preview tags (vitalik.eth.limo style): the first real paragraph of the article, whitespace collapsed", async () => {
    await open({
      pageHtml: page(
        "",
        "<header><p>Navigation and a byline that is long enough to count if it were in the article, more than eighty characters.</p></header>" +
          `<article><p>Jan 1, 2025</p><p>See <a href="/x">all posts</a></p><p>Special thanks to the many people\n   who reviewed this post. One of the most interesting questions is how to keep the base layer simple.</p><p>Second paragraph that never gets read because the first one already qualified for the card.</p></article>`,
      ),
    });
    await press("l");
    expect(messages()).toEqual([{ ...save("later"), description: LONG }]);
  });

  it("no article: main, then body", async () => {
    await open({ pageHtml: page("", `<div><p>Short.</p><p>${LONG}</p></div>`) });
    await press("l");
    expect(messages()[0]!.description).toBe(LONG);
  });

  it("a description is cut to 1000 characters", async () => {
    await open({ pageHtml: page(`<meta property="og:description" content="${"é".repeat(1500)}">`) });
    await press("l");
    expect(messages()[0]!.description).toBe("é".repeat(1000));
  });

  it.each([
    ["executeScript rejects (chrome:// page, Web Store, PDF viewer)", () => Promise.reject(new Error("Cannot access a chrome:// URL"))],
    ["executeScript throws", () => {
      throw new Error("Cannot access contents of the page");
    }],
    ["the read comes back empty (it threw in the page)", () => Promise.resolve([{ frameId: 0, result: null }])],
    ["no results at all", () => Promise.resolve([])],
    ["the result is the wrong shape", () => Promise.resolve([{ frameId: 0, result: { image: 42, description: ["x"] } }])],
  ])("%s: the save goes at once, without image or description", async (_name, executeScript) => {
    await open({ executeScript });
    await press("l");
    expect(messages()).toEqual([save("later")]);
  });

  it("no chrome.scripting at all (the permission missing): the save goes at once, as before", async () => {
    await open({ executeScript: null });
    expect((globalThis as any).chrome.scripting).toBeUndefined();
    await press("l");
    expect(messages()).toEqual([save("later")]);
  });

  it("a slow read: L right away waits until 300 ms after open, then sends without it", async () => {
    let finish!: (v: unknown) => void;
    await open({ executeScript: () => new Promise((resolve) => (finish = resolve)) });
    await press("l");
    expect(messages()).toEqual([]);
    expect(keycapFilled("later")).toBe(true);
    await wait(299);
    expect(messages()).toEqual([]);
    await wait(1);
    expect(messages()).toEqual([save("later")]);
    finish([{ frameId: 0, result: { image: COVER } }]); // too late to count
    await flush();
    await reply(0, { ok: true, id: "page-1" });
    expect(isShown("stamp-later")).toBe(true);
    expect(messages()).toEqual([save("later")]);
  });

  it("a read that never answers doesn't hold a later press at all", async () => {
    await open({ executeScript: () => new Promise(() => {}) });
    await wait(1000);
    await press("l");
    expect(messages()).toEqual([save("later")]);
  });

  it("a tab with no id: no read, the save goes as before", async () => {
    await open({ tab: { url: TAB.url, title: TAB.title }, pageHtml: page(`<meta property="og:image" content="${COVER}">`) });
    await press("l");
    expect(injections).toEqual([]);
    expect(messages()).toEqual([save("later")]);
  });

  it("setup missing: nothing is read from the page", async () => {
    await open({ storage: {}, pageHtml: page(`<meta property="og:image" content="${COVER}">`) });
    expect(injections).toEqual([]);
  });
});
