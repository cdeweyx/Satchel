import { NOTION_VERSION, PROPS, notionIds } from "./config";

// Plain-fetch Notion client (D-10). Satchel never retries Notion: any non-2xx, network
// failure or timeout throws NotionError at once, with no sleep and no Retry-After.
// SAT-6 catches exactly NotionError and returns 502 `notion_<code>`; anything else is a bug.

const API = "https://api.notion.com/v1";
const MAX_TEXT = 2000; // rich text `content` limit
const MAX_URL = 2000; // url property limit
const DEFAULT_TIMEOUT_MS = 5000;

export class NotionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? `notion ${status} ${code}`);
    this.name = "NotionError";
    this.status = status;
    this.code = code;
  }
}

// Property values Satchel writes. Tags only ever by option id (a name would create an option).
export type TagRef = { id: string };
export type PropertyValue =
  | { title: { text: { content: string } }[] }
  | { url: string | null }
  | { checkbox: boolean }
  | { multi_select: TagRef[] };
export type Properties = Record<string, PropertyValue>;

export type NotionPage = { object: "page"; id: string; properties: Record<string, unknown> } & Record<
  string,
  unknown
>;
export type SelectOption = { id: string; name: string; color?: string };
export type DataSourceProperty = {
  id: string;
  name: string;
  type: string;
  multi_select?: { options: SelectOption[] };
} & Record<string, unknown>;
export type DataSource = {
  object: "data_source";
  id: string;
  properties: Record<string, DataSourceProperty>;
} & Record<string, unknown>;

export type CallOptions = { timeoutMs?: number };

// The one page-body block Satchel writes (SAT-48): an external image or one paragraph.
export type ImageBlock = { type: "image"; image: { type: "external"; external: { url: string } } };
export type ParagraphBlock = { type: "paragraph"; paragraph: { rich_text: { type: "text"; text: { content: string } }[] } };
export type BodyBlock = ImageBlock | ParagraphBlock;

// --- Property builders, keyed by PROPS (never spell a property name inline) ---

// Truncate to Notion's 2000-char limit without splitting a surrogate pair.
export function truncateText(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

export function titleProp(text: string): Properties {
  return { [PROPS.name]: { title: [{ text: { content: truncateText(text) } }] } };
}

export function urlProp(url: string): Properties {
  assertUrlLength(url);
  return { [PROPS.url]: { url } };
}

export function checkboxProp(
  key: "archived" | "favorite" | "media",
  value: boolean,
): Properties {
  return { [PROPS[key]]: { checkbox: value } };
}

export function tagIdsProp(ids: string[]): Properties {
  return { [PROPS.tags]: { multi_select: ids.map((id) => ({ id })) } };
}

// Throws url_too_long past Notion's 2000-char limit, like urlProp.
export function imageBlock(url: string): ImageBlock {
  assertUrlLength(url);
  return { type: "image", image: { type: "external", external: { url } } };
}

export function paragraphBlock(text: string): ParagraphBlock {
  return { type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: truncateText(text) } }] } };
}

// Type guard: a tag reference is exactly {id: string}. A `name` key (or anything else) fails.
export function isTagRef(value: unknown): value is TagRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "id" && typeof (value as TagRef).id === "string";
}

function assertUrlLength(url: string): void {
  if (url.length > MAX_URL) throw new NotionError(400, "url_too_long");
}

// Runs before every write: rejects a long URL or a tag by name, truncates title content.
function guardProperties(props: Properties): Properties {
  const out: Properties = {};
  for (const [key, value] of Object.entries(props)) {
    if ("url" in value && typeof value.url === "string") assertUrlLength(value.url);
    if ("multi_select" in value) {
      if (!Array.isArray(value.multi_select) || !value.multi_select.every(isTagRef)) {
        throw new TypeError("multi_select must be [{id}] only, never a name");
      }
    }
    if ("title" in value) {
      out[key] = {
        title: value.title.map((t) => ({ text: { content: truncateText(t.text.content) } })),
      };
      continue;
    }
    out[key] = value;
  }
  return out;
}

// --- Client ---

export function notion(env: Env) {
  async function call<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    opts: CallOptions = {},
  ): Promise<T> {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch {
      if (signal.aborted) throw new NotionError(0, "timeout");
      throw new NotionError(0, "unreachable");
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      if (signal.aborted) throw new NotionError(0, "timeout");
      throw new NotionError(0, "unreachable");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    if (!res.ok) {
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { object?: unknown }).object === "error" &&
        typeof (parsed as { code?: unknown }).code === "string"
      ) {
        const { code, message } = parsed as { code: string; message?: unknown };
        throw new NotionError(res.status, code, typeof message === "string" ? message : undefined);
      }
      throw new NotionError(res.status, `http_${res.status}`);
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new NotionError(res.status, "bad_response");
    }
    return parsed as T;
  }

  const dataSourceId = () => notionIds(env).dataSourceId;

  return {
    retrieveDataSource(opts?: CallOptions): Promise<DataSource> {
      return call<DataSource>("GET", `/data_sources/${dataSourceId()}`, undefined, opts);
    },

    // One page only, oldest first (D-10). Returns `results` as Notion sends them.
    async query(filter: unknown, opts?: CallOptions): Promise<NotionPage[]> {
      const res = await call<{ results?: unknown }>(
        "POST",
        `/data_sources/${dataSourceId()}/query`,
        {
          filter,
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
          page_size: 5,
        },
        opts,
      );
      if (!Array.isArray(res.results)) throw new NotionError(200, "bad_response");
      return res.results as NotionPage[];
    },

    // Guards run inside the async body, so a rejected property is a rejection, not a sync throw.
    async createPage(props: Properties, opts?: CallOptions): Promise<NotionPage> {
      const properties = guardProperties(props);
      return call<NotionPage>(
        "POST",
        "/pages",
        { parent: { type: "data_source_id", data_source_id: dataSourceId() }, properties },
        opts,
      );
    },

    async patchPage(id: string, props: Properties, opts?: CallOptions): Promise<NotionPage> {
      const properties = guardProperties(props);
      return call<NotionPage>("PATCH", `/pages/${encodeURIComponent(id)}`, { properties }, opts);
    },

    retrievePage(id: string, opts?: CallOptions): Promise<NotionPage> {
      return call<NotionPage>("GET", `/pages/${encodeURIComponent(id)}`, undefined, opts);
    },

    // SAT-48: appends one block to a page's body. SAT-52: at the start, so it's the first block
    // (Notion-Version 2026-03-11 replaced the old `after` param with `position`).
    appendBlock(pageId: string, block: BodyBlock, opts?: CallOptions): Promise<unknown> {
      const body = { children: [block], position: { type: "start" } };
      return call<unknown>("PATCH", `/blocks/${encodeURIComponent(pageId)}/children`, body, opts);
    },
  };
}

export type NotionClient = ReturnType<typeof notion>;
