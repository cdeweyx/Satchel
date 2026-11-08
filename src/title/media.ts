// Media titles via public oEmbed endpoints (D-3, D-16; "Rules in full" > Title lookup).
// `stored` is the canonical URL from canonicalize(). One fetch per call, 4 s each. Apple
// Podcasts, Overcast, Pocket Casts and Twitch return null here: the page path reads their
// HTML (round 1 cut the Apple lookup API). Never throws: any failure is null.

export type MediaTitle = { title: string; source: "media-oembed"; bytesRead: number };

const FETCH_TIMEOUT_MS = 4000;

// Matched against the host after a `www.`/`m.` strip, exact or as a suffix (D-16).
const ENDPOINTS: ReadonlyArray<readonly [hosts: readonly string[], endpoint: string]> = [
  [["youtube.com", "youtu.be"], "https://www.youtube.com/oembed?format=json&url="],
  [["open.spotify.com"], "https://open.spotify.com/oembed?url="],
  [["vimeo.com"], "https://vimeo.com/api/oembed.json?url="],
  [["tiktok.com"], "https://www.tiktok.com/oembed?url="],
  [["soundcloud.com"], "https://soundcloud.com/oembed?format=json&url="],
];

function endpointFor(stored: string): string | null {
  let host: string;
  try {
    host = new URL(stored).hostname.toLowerCase().replace(/^(?:www|m)\./, "");
  } catch {
    return null;
  }
  for (const [hosts, endpoint] of ENDPOINTS) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      return `${endpoint}${encodeURIComponent(stored)}`;
    }
  }
  return null;
}

// Rejects when the signal aborts, so a mocked or real fetch that ignores the signal still
// can't hold the lookup past its timeout.
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readBody(res: Response): Promise<{ text: string; bytesRead: number }> {
  if (!res.body) return { text: "", bytesRead: 0 };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), bytesRead };
}

export async function lookupMedia(stored: string, signal: AbortSignal): Promise<MediaTitle | null> {
  const url = endpointFor(stored);
  if (!url) return null;
  try {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
    return await abortable(
      (async () => {
        const res = await fetch(url, { signal: combined, headers: { accept: "application/json" } });
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        const { text, bytesRead } = await readBody(res);
        const data: unknown = JSON.parse(text);
        const raw = data && typeof data === "object" ? (data as { title?: unknown }).title : undefined;
        const title = typeof raw === "string" ? raw.trim() : "";
        return title ? { title, source: "media-oembed" as const, bytesRead } : null;
      })(),
      combined,
    );
  } catch {
    return null;
  }
}
