// Satchel service worker (D-13). It owns the save, so closing the popup can't drop one.
//
// Contract for the popup (SAT-20):
//
//   Message  chrome.runtime.sendMessage({type: "save", url, title, status, image, description})
//            status is "later" | "read" | "favorite"; title may be omitted. image and
//            description (SAT-58) are the page's preview read from the tab, each omitted
//            when there isn't one; they go to the Worker as they are.
//   Reply    {ok: true, id} or {ok: false, error}. `error` is the Worker's error code,
//            or "unexpected response" for anything else (non-JSON body, network error,
//            no Worker URL or key in chrome.storage.local).
//   Port     While open, the popup holds chrome.runtime.connect({name: "popup"}).
//            A failure that arrives with no "popup" port connected sets a red "!" badge
//            on the toolbar icon; the next successful save clears it.
//            The popup must reconnect the "popup" port if it disconnects while the
//            popup is open (an idle MV3 worker can be shut down after ~30 s, which
//            drops the port).
//   Settings chrome.storage.local {workerUrl, key}, written by the options page.
//
// Saves for the same URL run one after another, in the order they arrive, so a
// favorite sent right after a read lands after it (the Worker turns it into a
// status update). Saves for different URLs don't wait on each other.

const POPUP_PORT = "popup";
const BADGE_FAILED = "!";
const BADGE_RED = "#D93025";
const UNEXPECTED = "unexpected response";

let popupPorts = 0;
const queues = new Map(); // url -> tail of that URL's promise chain

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT) return;
  popupPorts += 1;
  port.onDisconnect.addListener(() => {
    popupPorts -= 1;
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "save") return false;
  enqueue(message)
    .catch(() => ({ ok: false, error: UNEXPECTED }))
    .then((reply) => {
      try {
        sendResponse(reply);
      } catch {
        // The popup is gone; the badge already carries a failure.
      }
    });
  return true; // reply asynchronously
});

function enqueue(message) {
  const key = String(message.url);
  const previous = queues.get(key) ?? Promise.resolve();
  // Belt and braces: nothing upstream should reject, but a rejection mustn't stall
  // the next save for this URL.
  const run = previous.catch(() => {}).then(() => saveAndBadge(message));
  queues.set(key, run);
  const forget = () => {
    if (queues.get(key) === run) queues.delete(key);
  };
  run.then(forget, forget);
  return run;
}

async function saveAndBadge(message) {
  const reply = await save(message);
  // The badge is a hint; a badge API failure must never change the save's reply.
  try {
    if (reply.ok) {
      await chrome.action.setBadgeText({ text: "" });
    } else if (popupPorts === 0) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_RED });
      await chrome.action.setBadgeText({ text: BADGE_FAILED });
    }
  } catch {
    // Leave the badge as it was.
  }
  return reply;
}

// Never throws: every outcome becomes {ok: true, id} or {ok: false, error}.
async function save({ url, title, status, image, description }) {
  let response;
  try {
    const { workerUrl, key } = await chrome.storage.local.get(["workerUrl", "key"]);
    if (!workerUrl || !key) return { ok: false, error: UNEXPECTED };
    response = await fetch(`${String(workerUrl).replace(/\/$/, "")}/save`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-satchel-key": key },
      body: JSON.stringify({ url, title, status, image, description }),
    });
  } catch {
    return { ok: false, error: UNEXPECTED };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: UNEXPECTED };
  }
  // Success is only a JSON body with ok: true (D-4), whatever the HTTP status says.
  if (body && body.ok === true) return { ok: true, id: body.id };
  const error = body && typeof body.error === "string" && body.error ? body.error : UNEXPECTED;
  return { ok: false, error };
}
