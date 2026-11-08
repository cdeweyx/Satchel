// Claude title-and-tags call (D-8). One attempt, 10 s, structured output. Fails soft: any
// error, non-end_turn stop or unparseable output logs one `claude_failed` line and returns
// null, so the row stays as written.
import Anthropic from "@anthropic-ai/sdk";
import { logEvent } from "./log";

export const MODEL = "claude-haiku-5-5";

export type ClaudeInput =
  | { shape: "x"; author: string; handle?: string; text: string; url: string }
  | { shape: "titled"; title: string; description?: string; url: string }
  | { shape: "untitled"; description?: string; url: string };

export type ClaudeOutput = { title: string; tags: string[] };

// L2's prompt, with the user's Title Case ruling (2026-11-07) and tighter tag rules from the
// user's review of real saves and their 512 hand-tagged archive rows (SAT-38, 2026-11-08).
// The "any page text given" line reads "any description given": we never send page body
// text (D-8). Four reviewed saves are held out of the examples on purpose, so the live
// re-check measures the rules, not lookup.
const PROMPT = `You clean up titles for links saved to a personal reading database and pick tags for them.

Title rules:
- Keep the author's own title. Fix only what is noise.
- Drop site-name suffixes and prefixes like " | The Acme Blog", " - Medium", " — The New York Times", " · Substack".
- Drop leading "(12) " notification counts and trailing " - YouTube".
- For X / Twitter posts (input starts with "X post by"), write "Author: short gist" where the gist is a plain 4 to 10 word summary of the post, not a quote.
- If there is no usable title, write a short descriptive one from the URL and any description given.
- Never add commentary, emoji, or quotes around the title. Use Title Case for the title.

Tag rules:
- Pick one tag by default. Add a second only when the piece is substantially about that topic too. About half of saves get one tag, most of the rest two; three is rare (about 1 in 10). Never more than 3.
- Prefer the most specific tag that fits.
- Use a broad tag (Tech, Thinking, Growth) only when the piece is about that broad topic itself.
- Never add Tech alongside AI or Engineering for an AI or engineering piece.
- Never tag by source or format: a link from X isn't about social media, a video isn't Video.
- Use tags from the allowed list only. Never invent a tag. If nothing fits, pick the single closest one.

What some tags mean here:
- Tech: the business and strategy of the tech industry, not anything technical.
- Product: product management and building products.
- Career: doing well at work, the craft of your job, teams, interviewing.
- Self-Improvement: life advice and personal habits.
- Mindfulness: meaning and inner life.
- Thinking: essays about ideas and how to think.
- Growth: user and demand growth, not personal growth.
- Trends: predictions and what's next.
- Culture: cultural commentary.
- Projects: things people built (apps, tools, side projects).
- History: how things came to be, histories of objects, places and technology.

Examples (title → tags):
- The Art of Vibe Design → Design
- Naval: How to Get Rich Without Getting Lucky → Self-Improvement, Finance
- How AI Agents & Claude Skills Work → AI
- Paradigm Shifts and the Winner's Curse – Stratechery → Tech
- Seven Phrases I Stole From Staff Engineers → Career
- The Most Important Question of Your Life → Self-Improvement, Mindfulness
- The Growth Maze vs The Idea Maze → Growth

Allowed tags: `;

export function systemPrompt(allowedTags: string[]): string {
  return PROMPT + allowedTags.join(", ");
}

export function userMessage(input: ClaudeInput): string {
  switch (input.shape) {
    case "x": {
      const who = input.handle ? `${input.author} (@${input.handle})` : input.author;
      return `X post by ${who}: "${input.text}"\nURL: ${input.url}`;
    }
    case "titled":
      return lines(`Title: ${input.title}`, input.description, input.url);
    case "untitled":
      return lines("Title: (none)", input.description, input.url);
  }
}

function lines(title: string, description: string | undefined, url: string): string {
  const out = [title];
  if (description) out.push(`Description: ${description}`);
  out.push(`URL: ${url}`);
  return out.join("\n");
}

// maxItems is a 400 on Haiku 5.5 structured outputs; the 3-tag cap lives in guardTags.
export function outputSchema(allowedTags: string[]) {
  return {
    type: "object",
    properties: {
      title: { type: "string", description: "The cleaned title." },
      tags: {
        type: "array",
        minItems: 1,
        items: { type: "string", enum: allowedTags },
        description: "1 to 3 tags from the allowed list. Never more than 3.",
      },
    },
    required: ["title", "tags"],
    additionalProperties: false,
  };
}

class ClaudeOutputError extends Error {
  constructor(
    name: string,
    readonly status: number | null,
    readonly requestId: string | null,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(name);
    this.name = name;
  }
}

export async function cleanTitleAndTags(
  env: Env,
  input: ClaudeInput,
  allowedTags: string[],
  signal: AbortSignal,
): Promise<ClaudeOutput | null> {
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 10_000 });
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 512,
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: outputSchema(allowedTags) },
        },
        system: systemPrompt(allowedTags),
        messages: [{ role: "user", content: userMessage(input) }],
      },
      { signal },
    );
    const requestId = response._request_id ?? null;
    if (response.stop_reason !== "end_turn") {
      throw new ClaudeOutputError("StopReason", 200, requestId, { stopReason: response.stop_reason });
    }
    // Read by type: Haiku 5.5 can put a thinking block first.
    const text = response.content.find((b) => b.type === "text")?.text;
    const parsed = parseOutput(text);
    if (!parsed) throw new ClaudeOutputError("ParseError", 200, requestId);
    return parsed;
  } catch (err) {
    logFailure(err);
    return null;
  }
}

function parseOutput(text: string | undefined): ClaudeOutput | null {
  if (text === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { title, tags } = value as { title?: unknown; tags?: unknown };
  if (typeof title !== "string" || title.trim() === "") return null;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) return null;
  return { title: title.trim(), tags };
}

// Class, status and request id only. Never the key, the request or the response body.
function logFailure(err: unknown): void {
  if (err instanceof ClaudeOutputError) {
    logEvent("claude_failed", { class: err.name, status: err.status, requestId: err.requestId, ...err.extra });
  } else if (err instanceof Anthropic.APIError) {
    logEvent("claude_failed", { class: err.name, status: err.status ?? null, requestId: err.requestID ?? null });
  } else {
    const name = err instanceof Error ? err.name : "UnknownError";
    logEvent("claude_failed", { class: name, status: null, requestId: null });
  }
}
