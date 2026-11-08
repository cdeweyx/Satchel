import { canonicalize } from "./canonical";
import { type ErrorCode, json } from "./contract";
import { health } from "./health";
import { logEvent } from "./log";
import { handleSave } from "./save";
import { lookupTitle } from "./title";

// The router (D-4, "Rules in full" > Contract). Every response is JSON with `ok` and open
// CORS via json(), except the 204 preflight, which has no body.

type KeyState = "none" | "wrong" | "ok";

const STATUSES = new Set(["later", "read", "favorite"]);
const MAX_URL_LENGTH = 2000;
// The debug route's lookup cap, the same 5 s as enrich's lookup stage.
const DEBUG_LOOKUP_MS = 5000;

// CORS preflight: 204, no body, no key needed. /health needs one too, since the extension's
// Test button sends a keyed GET from a chrome-extension:// origin.
function preflight(methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "content-type, x-satchel-key",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function fail(status: number, error: ErrorCode, headers?: HeadersInit): Response {
  return json(status, { ok: false, error }, headers);
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

// "none" when the header is absent. Fails closed: an unset or blank SATCHEL_KEY makes every
// presented key "wrong", so an empty header can never match an empty secret. Both sides are
// hashed first so timingSafeEqual sees equal-length buffers and the key length doesn't leak.
async function keyState(req: Request, env: Env): Promise<KeyState> {
  const presented = req.headers.get("x-satchel-key");
  if (presented === null) return "none";
  const expected = env.SATCHEL_KEY;
  if (typeof expected !== "string" || expected.trim() === "") return "wrong";
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b) ? "ok" : "wrong";
}

// The only validator of a SaveRequest. Returns the error code, or null when the body is valid.
async function validateSave(req: Request): Promise<ErrorCode | null> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return "invalid_body";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "invalid_body";
  const { url, title, status } = body as Record<string, unknown>;
  if (typeof url !== "string" || url.trim() === "") return "invalid_body";
  if (title !== undefined && typeof title !== "string") return "invalid_body";
  if (typeof status !== "string" || !STATUSES.has(status)) return "invalid_body";
  return validateUrl(url);
}

// Shared by /save and /debug/title, in this order: length, then parse, then scheme.
// `url` is a non-blank string; the caller has already returned invalid_body otherwise.
function validateUrl(url: string): ErrorCode | null {
  const trimmed = url.trim();
  if (trimmed.length > MAX_URL_LENGTH) return "url_too_long";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "invalid_url";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "invalid_url";
  return null;
}

async function save(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if ((await keyState(req, env)) !== "ok") return fail(401, "unauthorized");
  const invalid = await validateSave(req.clone());
  if (invalid) return fail(400, invalid);
  // Body validated above on a clone; handleSave reads the original and trusts it as a SaveRequest.
  return await handleSave(req, env, ctx);
}

// GET /debug/title?url= (M1 debug route, risk 1): runs the real title lookup on the canonical
// URL and returns the raw result, so egress blocking shows up from curl. Key-gated like /save.
// Never logs the key or the URL.
async function debugTitle(req: Request, env: Env): Promise<Response> {
  if ((await keyState(req, env)) !== "ok") return fail(401, "unauthorized");
  const url = new URL(req.url).searchParams.get("url");
  if (url === null || url.trim() === "") return fail(400, "invalid_body");
  const invalid = validateUrl(url);
  if (invalid) return fail(400, invalid);

  const { stored, kind } = canonicalize(url);
  const started = Date.now();
  const result = await lookupTitle(stored, kind, AbortSignal.timeout(DEBUG_LOOKUP_MS));
  const ms = Date.now() - started;
  const source = result.source ?? "fallback";
  logEvent("debug_title", { kind, source, ms });
  return json(200, { ok: true, kind, stored, ...result, source, ms });
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    try {
      const { pathname } = new URL(req.url);
      if (pathname === "/save") {
        if (req.method === "POST") return await save(req, env, ctx);
        if (req.method === "OPTIONS") return preflight("POST, OPTIONS");
        return fail(405, "method_not_allowed", { Allow: "POST, OPTIONS" });
      }
      if (pathname === "/health") {
        if (req.method === "OPTIONS") return preflight("GET, OPTIONS");
        if (req.method !== "GET") return fail(405, "method_not_allowed", { Allow: "GET, OPTIONS" });
        const result = await health(env, await keyState(req, env));
        return json(result.status, result.body);
      }
      if (pathname === "/debug/title") {
        if (req.method !== "GET") return fail(405, "method_not_allowed", { Allow: "GET" });
        return await debugTitle(req, env);
      }
      return fail(404, "not_found");
    } catch {
      return fail(500, "internal");
    }
  },
} satisfies ExportedHandler<Env>;
