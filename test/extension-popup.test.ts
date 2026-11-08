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
    if (this.disabled || !this.rendered) return;
    this.doc.activeElement = this;
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

  constructor(html: string) {
    this.root = parseHtml(html, this);
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
const TAB = { url: "https://www.lennysnewsletter.com/p/how-linear-builds-product", title: "How Linear Builds Product" };

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

async function open({
  storage = { workerUrl: WORKER, key: KEY } as Record<string, unknown>,
  tab = TAB as { url?: string; title?: string },
  reducedMotion = false,
} = {}) {
  doc = new FakeDocument(popupHtml as string);
  sent = [];
  ports = [];
  closedAt = null;
  optionsOpened = 0;

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

  it("holds a popup port while open and reconnects it when it drops", async () => {
    await open();
    expect(ports.map((p) => [p.name, p.disconnected])).toEqual([["popup", false]]);
    ports[0]!.drop(); // an idle worker shut down
    expect(ports.map((p) => [p.name, p.disconnected])).toEqual([
      ["popup", true],
      ["popup", false],
    ]);
  });

  it("lets go of the port on close and doesn't reconnect", async () => {
    await open();
    await press("Escape");
    expect(closedAt).not.toBeNull();
    expect(ports.map((p) => p.disconnected)).toEqual([true]);
    ports[0]!.drop();
    expect(ports).toHaveLength(1);
  });

  it("esc closes at once and sends nothing", async () => {
    await open();
    await press("Escape");
    expect(elapsed()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("leaves the title out of the message when the tab has none, and shows the URL", async () => {
    await open({ tab: { url: "https://example.com/x" } });
    expect($("title").textContent).toBe("https://example.com/x");
    await press("l");
    expect(messages()).toEqual([{ type: "save", url: "https://example.com/x", status: "later" }]);
  });
});

// ---------- L: send to inbox ----------

describe("L sends later", () => {
  it("sends {type: save, url, title, status: later}, fills the L keycap, stamps on ok and closes 350 ms after the reply", async () => {
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

    await wait(349);
    expect(closedAt).toBeNull();
    await wait(1);
    expect(elapsed()).toBe(350);
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

  it("F within 1.5 s sends favorite after read, then stamps the Favorite row once both replies are ok", async () => {
    await open();
    await press("r");
    await wait(1400);
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
    await wait(350);
    expect(elapsed()).toBe(350);
  });

  it("the window ending closes: no F, the read's stamp, then close", async () => {
    await open();
    await press("r");
    await reply(0, { ok: true, id: "page-1" });
    await wait(1499);
    expect(isShown("row-favorite")).toBe(true);
    expect(isShown("stamp-read")).toBe(false);
    expect(closedAt).toBeNull();

    await wait(1);
    markNow();
    expect(isShown("row-favorite")).toBe(false);
    expect(isShown("stamp-read")).toBe(true);
    await wait(350);
    expect(elapsed()).toBe(350);
    expect(statuses()).toEqual(["read"]);
  });

  it("F after the window has closed sends nothing", async () => {
    await open();
    await press("r");
    await reply(0, { ok: true, id: "page-1" });
    await wait(1500);
    await press("f");
    expect(statuses()).toEqual(["read"]);
  });

  it("never shows SAVED before the read reply is ok", async () => {
    await open();
    await press("r");
    await wait(1500); // window over, read still in flight
    expect(isShown("row-favorite")).toBe(false);
    expect(isShown("stamp-read")).toBe(false);
    await wait(3000);
    expect(isShown("stamp-read")).toBe(false);
    expect(closedAt).toBeNull();

    await reply(0, { ok: true, id: "page-1" });
    markNow();
    expect(isShown("stamp-read")).toBe(true);
    await wait(350);
    expect(elapsed()).toBe(350);
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
      await wait(350);
      expect(elapsed()).toBe(350);
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
    await wait(1500);
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
