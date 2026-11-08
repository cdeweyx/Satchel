/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClaudeInput, cleanTitleAndTags, systemPrompt, userMessage } from "../src/claude";
import fixturesText from "./fixtures/claude.json?raw";
import { network } from "./network";

// Response and error shapes follow research 02 (2026-11-07): a Messages response with an
// optional empty thinking block first, a 401 `authentication_error` body with a
// `request-id` header, and a 200 `stop_reason: "refusal"`.

const MESSAGES = "https://api.anthropic.com/v1/messages";
const KEY = "test-anthropic-key"; // vitest.config.ts binding

type Fixture = {
  name: string;
  input: ClaudeInput;
  message: string;
  content: unknown[];
  expected: { title: string; tags: string[] };
};
const fixtures = JSON.parse(fixturesText) as { allowedTags: string[]; cases: Fixture[] };
const TAGS = fixtures.allowedTags;
const first = fixtures.cases[0]!;

type Captured = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };

function recorder() {
  const seen: Captured[] = [];
  const record = async (request: {
    url: string;
    method: string;
    headers: Headers;
    text(): Promise<string>;
  }) => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    seen.push({ url: request.url, method: request.method, headers, body });
  };
  return { seen, record };
}

function message(content: unknown[], stopReason = "end_turn", extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    {
      id: "msg_01Test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 960, output_tokens: 45 },
      ...extra,
    },
    { headers: { "request-id": "req_ok_123" } },
  );
}

function logLines(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

const signal = () => new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request shape", () => {
  it("sends the key as Authorization: Bearer, the pinned model, output_config, no temperature, no maxItems", async () => {
    const { seen, record } = recorder();
    network.use(
      http.post(MESSAGES, async ({ request }) => {
        await record(request);
        return message(first.content);
      }),
    );

    const out = await cleanTitleAndTags(env, first.input, TAGS, signal());
    expect(out).toEqual(first.expected);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;

    expect(req.method).toBe("POST");
    expect(req.url).toBe(MESSAGES);
    // SDK 1.6.0 sends apiKey as a bearer token (client.mjs apiKeyAuth), not x-api-key.
    expect(req.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers["anthropic-version"]).toBeTruthy();
    expect(req.headers["x-stainless-retry-count"]).toBe("0");

    expect(req.body).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 512,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              title: { type: "string", description: "The cleaned title." },
              tags: {
                type: "array",
                minItems: 1,
                items: { type: "string", enum: TAGS },
                description: "1 to 3 tags from the allowed list. Never more than 3.",
              },
            },
            required: ["title", "tags"],
            additionalProperties: false,
          },
        },
      },
      system: systemPrompt(TAGS),
      messages: [{ role: "user", content: first.message }],
    });

    const raw = JSON.stringify(req.body);
    expect(raw).not.toContain("maxItems");
    expect(raw).not.toContain("temperature");
    expect(raw).not.toContain("top_p");
    expect(raw).not.toContain("top_k");
    expect(raw).not.toContain("thinking");
    expect(raw).not.toContain("fallbacks");
  });

  it("system prompt asks for Title Case and lists the allowed tags", () => {
    const prompt = systemPrompt(TAGS);
    expect(prompt).toContain("Use Title Case for the title");
    expect(prompt).not.toContain("don't force Title Case");
    expect(prompt.endsWith(`Allowed tags: ${TAGS.join(", ")}`)).toBe(true);
  });

  it("system prompt tags fewer and more specific: one by default, broad tags gated, no source or format tags", () => {
    const prompt = systemPrompt(TAGS);
    expect(prompt).toContain("- Pick one tag by default. Add a second or third only when the piece is substantially about that topic too. Never more than 3.");
    expect(prompt).toContain("- Prefer the most specific tag that fits.");
    expect(prompt).toContain(
      "- Use a broad tag (Tech, Thinking, Creativity, Growth, Mindset, Business, Productivity, Social Media) only when the piece is about that broad topic itself.",
    );
    expect(prompt).toContain(
      "- Tech is only for broadly tech pieces. Never add Tech alongside AI or Engineering for an AI or engineering piece.",
    );
    expect(prompt).toContain("- Never tag by source or format: a link from X isn't Social Media, a video isn't Video.");
    expect(prompt).toContain("Never invent a tag. If nothing fits, pick the single closest one.");
    expect(prompt).not.toContain("Pick 1 to 3 tags");
  });

  it("system prompt holds exactly the three examples and none of the four held-out titles", () => {
    const prompt = systemPrompt(TAGS);
    const examples = prompt.slice(prompt.indexOf("Examples (title → tags):"), prompt.indexOf("Allowed tags: "));
    expect(examples.trim().split("\n")).toEqual([
      "Examples (title → tags):",
      "- The Art of Vibe Design → Design",
      "- Naval: How to Get Rich Without Getting Lucky → Self-Improvement, Finance",
      "- How AI Agents & Claude Skills Work → AI",
    ]);
    // Held out for the lead's live re-check (SAT-38): the prompt must not carry their answers.
    for (const heldOut of ["Levie", "last mile", "Good Retention", "Lenny", "Harder to Find", "Asterisk", "Leadership Lessons"]) {
      expect(prompt).not.toContain(heldOut);
    }
  });

  it("passes the caller's signal: an aborted signal stops the call and returns null", async () => {
    let hits = 0;
    network.use(
      http.post(MESSAGES, () => {
        hits++;
        return message(first.content);
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort();

    const out = await cleanTitleAndTags(env, first.input, TAGS, controller.signal);
    expect(out).toBeNull();
    expect(hits).toBe(0);
    expect(logLines(log)).toEqual([{ event: "claude_failed", class: "APIUserAbortError", status: null, requestId: null }]);
  });
});

describe("fixtures: one per input shape", () => {
  for (const c of fixtures.cases) {
    it(`${c.name}: renders the message and parses {title, tags}`, async () => {
      const { seen, record } = recorder();
      network.use(
        http.post(MESSAGES, async ({ request }) => {
          await record(request);
          return message(c.content);
        }),
      );

      expect(userMessage(c.input)).toBe(c.message);
      const out = await cleanTitleAndTags(env, c.input, TAGS, signal());
      expect(out).toEqual(c.expected);

      const sent = (seen[0]!.body.messages as { content: string }[])[0]!.content;
      expect(sent).toBe(c.message);
      expect(sent).not.toMatch(/Page text/i);
    });
  }

  it("covers all three shapes, and a thinking block before the text block", () => {
    expect(new Set(fixtures.cases.map((c) => c.input.shape))).toEqual(new Set(["x", "titled", "untitled"]));
    const thinkingFirst = fixtures.cases.filter((c) => (c.content[0] as { type: string }).type === "thinking");
    expect(thinkingFirst.length).toBeGreaterThan(0);
  });
});

describe("fails soft: null and one claude_failed line", () => {
  it("401 → null, logged class AuthenticationError with status and request id, never the key", async () => {
    let hits = 0;
    network.use(
      http.post(MESSAGES, () => {
        hits++;
        return HttpResponse.json(
          {
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
            request_id: "req_401_abc",
          },
          { status: 401, headers: { "request-id": "req_401_abc" } },
        );
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const out = await cleanTitleAndTags(env, first.input, TAGS, signal());
    expect(out).toBeNull();
    expect(hits).toBe(1); // maxRetries: 0
    expect(logLines(log)).toEqual([
      { event: "claude_failed", class: "AuthenticationError", status: 401, requestId: "req_401_abc" },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it("refusal stop_reason → null, logged with the stop reason and request id", async () => {
    network.use(
      http.post(MESSAGES, () =>
        message([], "refusal", {
          stop_details: { type: "refusal", category: null, explanation: "Declined." },
        }),
      ),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const out = await cleanTitleAndTags(env, first.input, TAGS, signal());
    expect(out).toBeNull();
    expect(logLines(log)).toEqual([
      { event: "claude_failed", class: "StopReason", status: 200, requestId: "req_ok_123", stopReason: "refusal" },
    ]);
  });

  it("max_tokens stop_reason → null", async () => {
    network.use(http.post(MESSAGES, () => message([{ type: "text", text: '{"title":"Cut' }], "max_tokens")));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await cleanTitleAndTags(env, first.input, TAGS, signal())).toBeNull();
    expect(logLines(log)).toEqual([
      { event: "claude_failed", class: "StopReason", status: 200, requestId: "req_ok_123", stopReason: "max_tokens" },
    ]);
  });

  for (const [label, content] of [
    ["invalid JSON", [{ type: "text", text: "Here is your title: Foo" }]],
    ["no text block", [{ type: "thinking", thinking: "", signature: "sig" }]],
    ["missing tags", [{ type: "text", text: '{"title":"Foo"}' }]],
    ["empty title", [{ type: "text", text: '{"title":"  ","tags":["AI"]}' }]],
    ["non-string tag", [{ type: "text", text: '{"title":"Foo","tags":[1]}' }]],
  ] as const) {
    it(`parse failure (${label}) → null, logged ParseError`, async () => {
      network.use(http.post(MESSAGES, () => message([...content])));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      expect(await cleanTitleAndTags(env, first.input, TAGS, signal())).toBeNull();
      expect(logLines(log)).toEqual([
        { event: "claude_failed", class: "ParseError", status: 200, requestId: "req_ok_123" },
      ]);
    });
  }

  it("500 → null, logged InternalServerError, one attempt", async () => {
    let hits = 0;
    network.use(
      http.post(MESSAGES, () => {
        hits++;
        return HttpResponse.json(
          { type: "error", error: { type: "api_error", message: "Internal server error" } },
          { status: 500, headers: { "request-id": "req_500" } },
        );
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await cleanTitleAndTags(env, first.input, TAGS, signal())).toBeNull();
    expect(hits).toBe(1);
    expect(logLines(log)).toEqual([
      { event: "claude_failed", class: "InternalServerError", status: 500, requestId: "req_500" },
    ]);
  });

  it("network error → null, logged APIConnectionError", async () => {
    network.use(http.post(MESSAGES, () => HttpResponse.error()));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await cleanTitleAndTags(env, first.input, TAGS, signal())).toBeNull();
    expect(logLines(log)).toEqual([
      { event: "claude_failed", class: "APIConnectionError", status: null, requestId: null },
    ]);
  });
});
