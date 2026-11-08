import { json } from "./contract";
import { health } from "./health";

// Stub router: /health only. SAT-4 builds the full router, auth, CORS preflight and 405s.
export default {
  async fetch(req, env, ctx): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        const result = await health(env, "none");
        return json(result.status, result.body);
      }
      return json(404, { ok: false, error: "not_found" });
    } catch {
      return json(500, { ok: false, error: "internal" });
    }
  },
} satisfies ExportedHandler<Env>;
