import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { network } from "./network";

describe("test network", () => {
  it("fails an unmocked request instead of reaching the network, even after a reset", async () => {
    // A reset must not drop the catch-all (it's the initial handler, not a use() override).
    network.resetHandlers();
    // A real request here would resolve with Notion's 401. The catch-all makes it reject.
    await expect(fetch("https://api.notion.com/v1/users/me")).rejects.toThrow(TypeError);
  });

  it("lets a per-test handler win over the catch-all", async () => {
    network.use(
      http.get("https://api.notion.com/v1/users/me", () =>
        HttpResponse.json({ object: "user", id: "mocked" }),
      ),
    );
    const res = await fetch("https://api.notion.com/v1/users/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "user", id: "mocked" });
  });
});
