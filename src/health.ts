// GET /health (D-4, D-9). Keyless is liveness, a wrong key is 401, the right key runs three
// live probes in parallel (Notion, Claude, X oEmbed), 3 s each, and answers 503 naming any
// probe that isn't "ok". No state. Never logs or returns the key or the token.
import Anthropic from "@anthropic-ai/sdk";
import type { HealthResponse, ProbeState } from "./contract";
import { NotionError, notion } from "./notion";

const PROBE_TIMEOUT_MS = 3000;
// A known, long-lived post (research 03): a failure here means the endpoint broke, not the post.
const OEMBED_POST = "https://x.com/jack/status/20";

// 401/403 → auth_failed, 404 → not_found, other non-2xx → error <status>, no response → error 0.
function fromStatus(status: number): ProbeState {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "not_found";
  return `error ${status}`;
}

async function probeNotion(env: Env): Promise<ProbeState> {
  try {
    await notion(env).retrieveDataSource({ timeoutMs: PROBE_TIMEOUT_MS });
    return "ok";
  } catch (err) {
    if (!(err instanceof NotionError)) return "error 0";
    if (err.code === "object_not_found") return "not_found";
    return err.status === 0 ? "error 0" : fromStatus(err.status);
  }
}

// models.list costs no tokens and reuses the exact auth the SAT-14 client sends.
async function probeClaude(env: Env): Promise<ProbeState> {
  try {
    const client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      maxRetries: 0,
      timeout: PROBE_TIMEOUT_MS,
    });
    await client.models.list({ limit: 1 }, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return "ok";
  } catch (err) {
    // APIConnectionError (and its timeout subclass) carry no status.
    if (err instanceof Anthropic.APIError && typeof err.status === "number") return fromStatus(err.status);
    return "error 0";
  }
}

// oEmbed needs no auth, so any non-2xx is "error <status>" (a 404 means the endpoint is gone).
// Ok only on a 2xx JSON body with a non-empty `html`; any other 2xx is "error <status>".
async function probeOembed(): Promise<ProbeState> {
  const u = new URL("https://publish.x.com/oembed");
  u.searchParams.set("url", OEMBED_POST);
  u.searchParams.set("omit_script", "true");
  u.searchParams.set("dnt", "true");
  let res: Response;
  try {
    res = await fetch(u.toString(), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return "error 0";
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return `error ${res.status}`;
  }
  try {
    const body = (await res.json()) as { html?: unknown } | null;
    if (typeof body?.html === "string" && body.html.trim() !== "") return "ok";
  } catch {
    // Not JSON, or the body read timed out.
  }
  return `error ${res.status}`;
}

function settled(result: PromiseSettledResult<ProbeState>): ProbeState {
  return result.status === "fulfilled" ? result.value : "error 0";
}

export async function health(
  env: Env,
  keyState: "none" | "wrong" | "ok",
): Promise<{ status: 200 | 401 | 503; body: HealthResponse }> {
  if (keyState === "none") return { status: 200, body: { ok: true } };
  if (keyState === "wrong") return { status: 401, body: { ok: false, error: "unauthorized" } };

  const [n, c, o] = await Promise.allSettled([probeNotion(env), probeClaude(env), probeOembed()]);
  const probes = { notion: settled(n), claude: settled(c), oembed: settled(o) };
  const ok = probes.notion === "ok" && probes.claude === "ok" && probes.oembed === "ok";
  return { status: ok ? 200 : 503, body: { ok, ...probes } };
}
