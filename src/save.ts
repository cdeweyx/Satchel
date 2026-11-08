import { type DedupeKey, canonicalize } from "./canonical";
import { PROPS } from "./config";
import { type EnrichJob, type SaveRequest, json } from "./contract";
import { enrich } from "./enrich";
import { fallbackTitle, isMissingTitle } from "./fallback-title";
import { logEvent } from "./log";
import { NotionError, type NotionPage, type Properties, checkboxProp, notion, titleProp, urlProp } from "./notion";

// POST /save (D-1, D-2, D-10). The response path is one dedupe query plus one create or
// patch, nothing else. Enrich runs in waitUntil, and only after a create.

// Each sync Notion call gets 3 s (the client's default is 5 s); the budget is 1.5 s typical.
const SYNC = { timeoutMs: 3000 };

type Stage = "guard" | "query" | "create" | "patch";

type UrlFilter = { property: string; url: { equals: string } | { starts_with: string } | { contains: string } };
export type DedupeFilter = UrlFilter | { or: UrlFilter[] };

// Host plus a lone "/" path and no query: the only stored form that ends in a slash.
const ROOT = /^https:\/\/[^/?#]+\/$/;

const url = (cond: UrlFilter["url"]): UrlFilter => ({ property: PROPS.url, url: cond });

// "Rules in full" → Canonicalization (D-5): for both host forms, equals, equals + "/",
// starts_with + "?", starts_with + "#"; then equals raw. Always 9 clauses in one flat `or`,
// even when raw repeats a stored form (a duplicate clause is harmless). Revised in build (D-2):
// a root URL's stored form ends in "/", so its slash clause is the form without it (matches an
// old bare-host row); a stored form that already has a query uses starts_with + "&" (matches
// an old row with extra params). X: one `contains "/status/<id>"`, post-filtered by xMatches.
export function dedupeFilter(key: DedupeKey): DedupeFilter {
  if (key.type === "x") return url({ contains: `/status/${key.id}` });
  const clauses: UrlFilter[] = [];
  for (const form of [key.bare, key.www]) {
    clauses.push(
      url({ equals: form }),
      url({ equals: ROOT.test(form) ? form.slice(0, -1) : `${form}/` }),
      url({ starts_with: form.includes("?") ? `${form}&` : `${form}?` }),
      url({ starts_with: `${form}#` }),
    );
  }
  clauses.push(url({ equals: key.raw }));
  return { or: clauses };
}

// `contains "/status/20"` also matches `/status/2001`. A real hit has the id followed by the
// end of the URL or a non-digit (`?`, `/`, `#`).
function xMatches(page: NotionPage, id: string): boolean {
  const value = (page.properties[PROPS.url] as { url?: unknown } | undefined)?.url;
  return typeof value === "string" && new RegExp(`/status/${id}(?!\\d)`).test(value);
}

// Contract (D-4) status map: later → false/false, read → true/false, favorite → true/true.
function statusProps(status: SaveRequest["status"]): Properties {
  return {
    ...checkboxProp("archived", status !== "later"),
    ...checkboxProp("favorite", status === "favorite"),
  };
}

// The router authenticated and validated the body on a clone; this reads the original once.
async function save(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const body = (await req.json()) as SaveRequest;
  const raw = body.url.trim();
  const c = canonicalize(raw);
  const title = body.title?.trim();
  const clientTitle = isMissingTitle(title, raw, c.stored) ? undefined : title;
  const fallback = fallbackTitle(raw, c.kind);
  const client = notion(env);

  let stage: Stage = "guard";
  try {
    // Runs the client's URL guard before any request: an over-long stored URL fails here.
    const urlProps = urlProp(c.stored);

    stage = "query";
    const results = await client.query(dedupeFilter(c.dedupe), SYNC);
    const key = c.dedupe;
    const matches = key.type === "x" ? results.filter((p) => xMatches(p, key.id)) : results;
    const hit = matches[0]; // oldest surviving match wins; none is a miss

    if (hit) {
      stage = "patch";
      await client.patchPage(hit.id, statusProps(body.status), SYNC);
      logEvent("save", { action: "update", kind: c.kind, ms: Date.now() - started });
      return json(200, { ok: true, id: hit.id });
    }

    // Known gap, accepted (D-10, fail visibly): if this create commits in Notion but its
    // response times out, the client sees 502 and a re-save finds the row as a dedupe hit,
    // so that row never gets enrich. No retry or reconciliation by design.
    stage = "create";
    const page = await client.createPage(
      {
        ...titleProp(clientTitle ?? fallback),
        ...urlProps,
        ...statusProps(body.status),
        ...checkboxProp("media", c.media),
      },
      SYNC,
    );
    const job: EnrichJob = {
      pageId: page.id,
      storedUrl: c.stored,
      kind: c.kind,
      clientTitle,
      fallbackTitle: fallback,
    };
    ctx.waitUntil(enrich(job, env));
    logEvent("save", { action: "create", kind: c.kind, ms: Date.now() - started });
    return json(200, { ok: true, id: page.id });
  } catch (err) {
    // Only Notion failures are a 502. Anything else is a bug: rethrow for the router's 500.
    if (!(err instanceof NotionError)) throw err;
    logEvent("save_failed", { code: err.code, status: err.status, stage });
    return json(502, { ok: false, error: `notion_${err.code}` });
  }
}

export async function handleSave(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const p = save(req, env, ctx);
  // waitUntil gets a copy that can't reject, so a client disconnect can't cancel the write;
  // the awaited original drives the response (and a non-Notion error still reaches the router).
  ctx.waitUntil(p.catch(() => {}));
  return await p;
}
