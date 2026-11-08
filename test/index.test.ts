import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function call(method: string, path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://satchel.test${path}`, { method }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("stub router", () => {
  it("GET /health returns 200 {ok:true} as JSON with open CORS", async () => {
    const res = await call("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("an unknown path returns 404 {ok:false, error:not_found} as JSON", async () => {
    const res = await call("GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: false, error: "not_found" });
  });
});
