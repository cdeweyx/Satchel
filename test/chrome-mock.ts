// A small fake of the chrome.* APIs extension/background.js uses, for the node Vitest
// project. It keeps real state (storage, badge text and colour, open ports) so tests
// assert on what the worker did, not on which mock it called.

type Listener = (...args: any[]) => unknown;

class FakeEvent {
  listeners: Listener[] = [];
  addListener(fn: Listener) {
    this.listeners.push(fn);
  }
  removeListener(fn: Listener) {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  hasListener(fn: Listener) {
    return this.listeners.includes(fn);
  }
  fire(...args: unknown[]) {
    return this.listeners.map((l) => l(...args));
  }
}

export type BadgeCall =
  | { method: "setBadgeText"; text: string }
  | { method: "setBadgeBackgroundColor"; color: string };

export interface ChromeMock {
  chrome: unknown;
  storage: Record<string, unknown>;
  badge: { text: string; color: string | undefined; calls: BadgeCall[] };
  // Sends a message the way the popup would and resolves with the worker's reply.
  sendMessage(message: unknown): Promise<unknown>;
  // Opens a port the way the popup would; close() is the popup going away.
  connect(name: string): { close(): void };
}

export function createChromeMock(storage: Record<string, unknown> = {}): ChromeMock {
  const onMessage = new FakeEvent();
  const onConnect = new FakeEvent();
  const badge: ChromeMock["badge"] = { text: "", color: undefined, calls: [] };

  const chrome = {
    runtime: { onMessage, onConnect },
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          if (keys == null) return { ...storage };
          const wanted = typeof keys === "string" ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const k of wanted) if (k in storage) out[k] = storage[k];
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(storage, items);
        },
      },
    },
    action: {
      async setBadgeText({ text }: { text: string }) {
        badge.text = text;
        badge.calls.push({ method: "setBadgeText", text });
      },
      async setBadgeBackgroundColor({ color }: { color: string }) {
        badge.color = color;
        badge.calls.push({ method: "setBadgeBackgroundColor", color });
      },
    },
  };

  return {
    chrome,
    storage,
    badge,
    sendMessage(message) {
      return new Promise((resolve, reject) => {
        let replied = false;
        const sendResponse = (reply: unknown) => {
          replied = true;
          resolve(reply);
        };
        const results = onMessage.fire(message, { id: "satchel-test" }, sendResponse);
        // Chrome closes the channel unless a listener returned true (async reply).
        if (!replied && !results.includes(true)) reject(new Error("no async reply"));
      });
    },
    connect(name) {
      const onDisconnect = new FakeEvent();
      const port = { name, onDisconnect, onMessage: new FakeEvent(), postMessage() {}, disconnect() {} };
      onConnect.fire(port);
      // Chrome fires onDisconnect on the other end only, so closing the popup fires it here.
      return { close: () => void onDisconnect.fire(port) };
    },
  };
}
