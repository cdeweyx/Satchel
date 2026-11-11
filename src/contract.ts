// The Worker's public contract (D-4, "Rules in full" > Contract).
// Read by the router (SAT-4), save (SAT-6), enrich (SAT-12) and health (SAT-16).

export type ErrorCode =
  | "invalid_body"
  | "invalid_url"
  | "url_too_long"
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "internal"
  | `notion_${string}`;

// SAT-58: `image` and `description` are the preview the Chrome extension read from the open
// tab. Untrusted: save.ts keeps only valid values and drops the rest silently (never a 400).
export type SaveRequest = {
  url: string;
  title?: string;
  status: "later" | "read" | "favorite";
  image?: string;
  description?: string;
};

export type ProbeState = "ok" | "auth_failed" | "not_found" | `error ${number}`;

// Keyless liveness is {ok: true}; keyed probes fill notion/claude/oembed.
export type HealthResponse = {
  ok: boolean;
  error?: ErrorCode;
  notion?: ProbeState;
  claude?: ProbeState;
  oembed?: ProbeState;
};

export type EnrichJob = {
  pageId: string;
  storedUrl: string;
  kind: "x" | "media" | "page";
  clientTitle?: string;
  fallbackTitle: string;
  // SAT-58: the client's preview, cleaned by save.ts. Only the page body uses them, and only
  // for a page whose own lookup gave no block.
  clientImage?: string;
  clientDescription?: string;
};

// Every Worker response goes through here: JSON, with `ok`, and CORS open to any origin.
// Extra headers merge in, but content-type and Access-Control-Allow-Origin can't be overridden.
export function json(
  status: number,
  body: { ok: boolean } & Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  const merged = new Headers(headers);
  merged.set("content-type", "application/json");
  merged.set("Access-Control-Allow-Origin", "*");
  return new Response(JSON.stringify(body), { status, headers: merged });
}
