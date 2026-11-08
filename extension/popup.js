// Satchel popup (SAT-20). Keyboard-first: L sends to inbox, R marks as archived,
// F favorites for 3 s after R, esc closes. Every action also works
// with a click, and arrow keys / Tab / Enter work on the rows.
//
// The service worker owns every save (contract at the top of background.js). The popup
// only sends {type: "save", url, title, status}, shows the reply, and holds the "popup"
// port while it's open so a failure it can show doesn't also badge the toolbar icon.

const FAVORITE_WINDOW_MS = 3000;
const CLOSE_AFTER_MS = 600; // after the reply: the save beat, then close
const POPUP_PORT = "popup";
const NO_REPLY = "no reply";
const LABELS = { later: "Send to inbox", read: "Mark as archived", favorite: "Favorite" };
const ERROR_LABEL = "Couldn't save, try again";
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS"]);
const STATUSES = ["later", "read", "favorite"];
const RECONNECT_MS = [250, 1000]; // then 1 s each time, so a broken worker can't spin a loop
const PORT_SETTLED_MS = 5000; // a port that lived this long resets the backoff

const $ = (id) => document.getElementById(id);
const rowOf = (status) => $(`row-${status}`);

// loading | setup | rest | window (R's favorite window) | pending | saved | error | closed
let state = "loading";
let page = { url: "", title: "" };
let port = null;
let portOpenedAt = 0;
let reconnects = 0;
let reconnectTimer = null;
let closing = false;
let windowTimer = null;
let readReply = null; // the read save's reply (a promise) once R is pressed
let errorOn = null; // the status whose save failed, while state is "error"

// One row looks selected at a time: the focused one, or (while every row is disabled)
// the row the state points at. Focus moving to a row moves the selection with it.
function select(row) {
  for (const s of STATUSES) rowOf(s).classList.toggle("is-current", rowOf(s) === row);
}

function setState(next) {
  state = next;
  $("popup").setAttribute("data-state", next);
}

// ---- talking to the service worker ----

function connectPort() {
  reconnectTimer = null;
  if (closing) return;
  try {
    port = chrome.runtime.connect({ name: POPUP_PORT });
  } catch {
    port = null;
    scheduleReconnect();
    return;
  }
  portOpenedAt = Date.now();
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // read it so Chrome doesn't log it as unchecked
    port = null;
    if (Date.now() - portOpenedAt >= PORT_SETTLED_MS) reconnects = 0;
    // An idle worker can be shut down, which drops the port. Hold a new one while open.
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (closing || reconnectTimer) return;
  const delay = RECONNECT_MS[Math.min(reconnects, RECONNECT_MS.length - 1)];
  reconnects += 1;
  reconnectTimer = setTimeout(connectPort, delay);
}

// Always resolves, to {ok: true, id} or {ok: false, error}.
function send(status) {
  const message = { type: "save", url: page.url, status };
  if (page.title) message.title = page.title;
  let reply;
  try {
    reply = chrome.runtime.sendMessage(message);
  } catch {
    return Promise.resolve({ ok: false, error: NO_REPLY });
  }
  return Promise.resolve(reply).then(normalize, () => ({ ok: false, error: NO_REPLY }));
}

function normalize(reply) {
  if (reply && reply.ok === true) return reply;
  const error = reply && typeof reply.error === "string" && reply.error ? reply.error : NO_REPLY;
  return { ok: false, error };
}

// ---- actions ----

// A press: clear any error, disable the rows (no double saves), fill the pressed keycap.
function begin(status) {
  errorOn = null;
  for (const s of STATUSES) {
    const row = rowOf(s);
    row.disabled = true;
    row.classList.remove("is-active", "is-current", "is-error", "is-saved");
    $(`label-${s}`).textContent = LABELS[s];
    $(`detail-${s}`).textContent = "";
    $(`detail-${s}`).hidden = true;
  }
  rowOf(status).classList.add("is-active");
  $("status").textContent = "";
}

async function pressLater() {
  if (state !== "rest" && state !== "error") return;
  begin("later");
  hideFavorite();
  setState("pending");
  settle("later", await send("later"));
}

function pressRead() {
  if (state !== "rest" && state !== "error") return;
  begin("read");
  const reply = send("read"); // at once: the favorite window doesn't hold the read back
  readReply = reply;
  openWindow();
  reply.then((r) => {
    // A failed read ends the window early. A good one waits for the window to end.
    if (readReply === reply && state === "window" && !r.ok) {
      clearTimeout(windowTimer);
      hideFavorite();
      failed("read", r.error);
    }
  });
}

function openWindow() {
  setState("window");
  const fav = rowOf("favorite");
  fav.hidden = false;
  fav.disabled = false;
  fav.focus(); // Enter here still ends the window (onKey), it doesn't favorite
  select(fav);
  windowTimer = setTimeout(endWindow, FAVORITE_WINDOW_MS);
}

// Esc, Enter, any other key, or the 3 s running out: settle the read save.
async function endWindow() {
  if (state !== "window") return;
  clearTimeout(windowTimer);
  hideFavorite();
  setState("pending");
  settle("read", await readReply);
}

async function pressFavorite() {
  const retry = state === "error" && errorOn === "favorite";
  if (state !== "window" && !retry) return;
  clearTimeout(windowTimer);
  begin("favorite");
  rowOf("favorite").hidden = false;
  select(rowOf("favorite"));
  setState("pending");
  // Sent now; the service worker runs it after the read for the same URL. SAVED waits
  // for both replies, and follows the favorite's: if it landed, the page is saved.
  const [, fav] = await Promise.all([readReply, send("favorite")]);
  settle("favorite", fav);
}

function settle(status, reply) {
  if (state !== "pending") return; // closed meanwhile
  if (reply.ok) saved(status);
  else failed(status, reply.error);
}

function hideFavorite() {
  const fav = rowOf("favorite");
  fav.hidden = true;
  fav.disabled = true;
  fav.classList.remove("is-current");
}

// The save beat: the keycap is already filled, the SAVED plate lands, then close.
function saved(status) {
  setState("saved");
  const row = rowOf(status);
  row.classList.add("is-active", "is-saved");
  select(row);
  $(`stamp-${status}`).hidden = false;
  $("status").textContent = "Saved";
  if (reducedMotion()) closePopup();
  else setTimeout(closePopup, CLOSE_AFTER_MS);
}

// The popup stays open; the row keeps its place and swaps its label. L and R retry.
function failed(status, error) {
  setState("error");
  errorOn = status;
  for (const s of ["later", "read"]) rowOf(s).disabled = false;
  const row = rowOf(status);
  row.classList.remove("is-active");
  row.classList.add("is-error");
  select(row);
  row.disabled = false;
  $(`label-${status}`).textContent = ERROR_LABEL;
  $(`detail-${status}`).textContent = error;
  $(`detail-${status}`).hidden = false;
  $("status").textContent = `${ERROR_LABEL}: ${error}`;
  row.focus();
}

function closePopup() {
  if (closing) return;
  closing = true;
  clearTimeout(windowTimer);
  clearTimeout(reconnectTimer);
  setState("closed");
  try {
    port?.disconnect();
  } catch {
    // Already gone.
  }
  window.close();
}

function openSetup() {
  if (state !== "setup") return;
  try {
    chrome.runtime.openOptionsPage();
  } catch {
    // Nothing else to try from a popup.
  }
  closePopup();
}

function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ---- keys ----

function moveFocus(step) {
  const rows = STATUSES.map(rowOf).filter((r) => !r.hidden && !r.disabled);
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement);
  const next = at === -1 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length;
  rows[next].focus();
}

function onKey(event) {
  // A held key repeats; only the first press counts (holding R mustn't end the window).
  if (event.repeat) {
    event.preventDefault();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || MODIFIER_KEYS.has(event.key)) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (state === "window") {
    event.preventDefault();
    if (key === "f") pressFavorite();
    else endWindow();
    return;
  }
  if (key === "Escape") {
    event.preventDefault();
    closePopup();
    return;
  }
  if (state === "setup") {
    if (key === "s") {
      event.preventDefault();
      openSetup();
    }
    return;
  }
  if (state !== "rest" && state !== "error") return;

  if (key === "l") {
    event.preventDefault();
    pressLater();
  } else if (key === "r") {
    event.preventDefault();
    pressRead();
  } else if (key === "f" && errorOn === "favorite") {
    event.preventDefault();
    pressFavorite();
  } else if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    moveFocus(key === "ArrowDown" ? 1 : -1);
  } else if (key === "Enter" || key === " ") {
    const focused = document.activeElement;
    if (STATUSES.some((s) => rowOf(s) === focused)) {
      event.preventDefault();
      focused.click();
    }
  }
}

// ---- start ----

// Only web pages have a site name. On chrome://, chrome-extension://, file:// or about:
// the "hostname" is a page name or the extension's ID, so the line stays empty.
function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Chrome names an untitled tab after its URL (with or without the scheme) and an image
// tab "name.ext (W×H)". Those aren't titles, so the Worker gets none and finds its own.
function clientTitle(title, url) {
  const t = title.trim();
  if (!t) return "";
  const bare = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const fallbacks = [url, bare, bare.replace(/\/$/, ""), decodeSafe(bare), decodeSafe(bare).replace(/\/$/, "")];
  if (fallbacks.includes(t)) return "";
  if (/^[^/\\]+\.[a-z0-9]{2,5} \(\d+\s*[×x]\s*\d+\)$/i.test(t)) return "";
  return t;
}

function decodeSafe(s) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

async function init() {
  connectPort();
  document.addEventListener("keydown", onKey);
  rowOf("later").addEventListener("click", () => pressLater());
  rowOf("read").addEventListener("click", () => pressRead());
  rowOf("favorite").addEventListener("click", () => pressFavorite());
  for (const s of STATUSES) {
    const row = rowOf(s);
    row.addEventListener("focus", () => select(row));
    // Hover moves focus, so the row that looks selected is the one Enter activates.
    row.addEventListener("pointerenter", () => row.focus());
  }
  $("setup-link").addEventListener("click", (event) => {
    event.preventDefault();
    openSetup();
  });

  const [tabs, settings] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
    chrome.storage.local.get(["workerUrl", "key"]).catch(() => ({})),
  ]);
  if (closing) return;
  const tab = (tabs && tabs[0]) || {};
  const url = tab.url || "";
  page = { url, title: clientTitle(tab.title || "", url) };
  $("domain").textContent = domainOf(url);
  $("title").textContent = tab.title || url;

  if (!settings || !settings.workerUrl || !settings.key) {
    setState("setup");
    $("setup").hidden = false;
    $("setup-link").focus();
  } else {
    setState("rest");
    $("rows").hidden = false;
    rowOf("later").focus();
  }
}

init();
