// Satchel options page (D-9, D-13). Two settings in chrome.storage.local (never sync: the
// two Chrome profiles are different Google accounts), Save, and Test, which calls the keyed
// GET <workerUrl>/health and shows each probe in plain words.
//
// Keyboard: Enter in a field saves (the form's submit). T runs Test when no field has focus.

const FIELDS = [
  ["notion", "Notion"],
  ["claude", "Claude"],
  ["oembed", "X oEmbed"],
];
// The Worker's probes take up to 3 s each, in parallel; past this the Worker is as good as gone.
const TEST_TIMEOUT_MS = 10000;
const PRESS_MS = 160;

export const WORDS = {
  keyRejected: "Key rejected",
  unreachable: "Can't reach Worker",
  missing: "Add the Worker URL and save key first.",
  badUrl: "The Worker URL should look like https://satchel.you.workers.dev",
  saved: "Saved.",
  testing: "Testing…",
};

// One probe state from /health in words: ok | auth_failed | not_found | error <status>.
export function probeWords(state) {
  if (state === "ok") return "ok";
  if (state === "auth_failed") return "key rejected";
  if (state === "not_found") return "not found";
  const m = typeof state === "string" ? /^error (\d+)$/.exec(state) : null;
  if (m) return m[1] === "0" ? "down" : `down (${m[1]})`;
  return "no answer";
}

// <workerUrl>/health with one trailing slash stripped, the same rule the service worker uses.
export function healthUrl(workerUrl) {
  return `${workerUrl.replace(/\/$/, "")}/health`;
}

export function isWorkerUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// Calls the keyed /health and returns what to show: {message} for one line, or {lines} with
// one entry per probe ({text, ok}). Never throws.
export async function runTest(workerUrl, key) {
  let response;
  try {
    response = await fetch(healthUrl(workerUrl), {
      method: "GET",
      headers: { "x-satchel-key": key },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { message: WORDS.unreachable, error: true };
  }
  if (response.status === 401) return { message: WORDS.keyRejected, error: true };

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON: falls through to "Unexpected response".
  }
  if (body && FIELDS.some(([field]) => typeof body[field] === "string")) {
    return {
      lines: FIELDS.map(([field, name]) => ({
        text: `${name}: ${probeWords(body[field])}`,
        ok: body[field] === "ok",
      })),
    };
  }
  return { message: `Unexpected response (${response.status})`, error: true };
}

// Wires the page. `doc` is the document; chrome and fetch are the globals. Resolves once the
// stored values are in the fields. Each handler returns its promise so a test can await it.
export async function init(doc) {
  const $ = (id) => doc.getElementById(id);
  const form = $("settings");
  const urlInput = $("worker-url");
  const keyInput = $("key");
  const showKey = $("show-key");
  const saveButton = $("save");
  const testButton = $("test");
  const status = $("status");
  const results = $("results");
  let testing = false;

  function say(text, error = false) {
    status.textContent = text;
    if (error) status.setAttribute("data-tone", "error");
    else status.removeAttribute("data-tone");
  }

  function press(button, ms) {
    button.setAttribute("data-pressed", "");
    if (ms) setTimeout(() => button.removeAttribute("data-pressed"), ms);
  }

  function values() {
    return { workerUrl: urlInput.value.trim(), key: keyInput.value.trim() };
  }

  async function save() {
    const { workerUrl, key } = values();
    results.replaceChildren();
    if (workerUrl && !isWorkerUrl(workerUrl)) {
      say(WORDS.badUrl, true);
      return;
    }
    press(saveButton, PRESS_MS);
    await chrome.storage.local.set({ workerUrl, key });
    urlInput.value = workerUrl;
    keyInput.value = key;
    say(WORDS.saved);
  }

  async function test() {
    if (testing) return;
    const { workerUrl, key } = values();
    results.replaceChildren();
    if (!workerUrl || !key) {
      say(WORDS.missing, true);
      return;
    }
    if (!isWorkerUrl(workerUrl)) {
      say(WORDS.badUrl, true);
      return;
    }
    testing = true;
    testButton.disabled = true;
    press(testButton);
    say(WORDS.testing);
    try {
      const outcome = await runTest(workerUrl, key);
      if (outcome.lines) {
        say("");
        results.replaceChildren(
          ...outcome.lines.map(({ text, ok }) => {
            const li = doc.createElement("li");
            li.textContent = text;
            if (!ok) li.setAttribute("data-tone", "error");
            return li;
          }),
        );
      } else {
        say(outcome.message, outcome.error);
      }
    } finally {
      testing = false;
      testButton.disabled = false;
      testButton.removeAttribute("data-pressed");
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    return save();
  });
  testButton.addEventListener("click", () => test());
  showKey.addEventListener("click", () => {
    const show = keyInput.type === "password";
    keyInput.type = show ? "text" : "password";
    showKey.textContent = show ? "Hide" : "Show";
    showKey.setAttribute("aria-pressed", String(show));
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "t" && event.key !== "T") return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (isField(doc.activeElement)) return;
    event.preventDefault();
    return test();
  });

  const stored = await chrome.storage.local.get(["workerUrl", "key"]);
  if (typeof stored.workerUrl === "string") urlInput.value = stored.workerUrl;
  if (typeof stored.key === "string") keyInput.value = stored.key;
}

function isField(el) {
  if (!el) return false;
  const tag = String(el.tagName).toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

if (typeof document !== "undefined" && document.getElementById("settings")) init(document);
