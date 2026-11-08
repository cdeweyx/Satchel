import type { HealthResponse } from "./contract";

// GET /health. Stub: SAT-16 fills the keyed probes. Signature is final.
export async function health(
  env: Env,
  keyState: "none" | "wrong" | "ok",
): Promise<{ status: 200 | 401 | 503; body: HealthResponse }> {
  return { status: 200, body: { ok: true } };
}
