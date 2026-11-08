import { json } from "./contract";

// POST /save. Stub: SAT-6 fills the body. Signature is final.
export async function handleSave(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return json(500, { ok: false, error: "internal" });
}
