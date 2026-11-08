// URL canonicalization (D-5) and the Media flag (D-16). Pure: no network, no redirect
// following. Rules come from the plan appendix "Rules in full" → "Canonicalization (D-5)".

export type DedupeKey =
  | { type: "x"; id: string }
  | { type: "url"; bare: string; www: string; raw: string };

export interface Canonical {
  stored: string;
  dedupe: DedupeKey;
  kind: "x" | "media" | "page";
  media: boolean;
}

const GLOBAL_EXACT = new Set(
  (
    "fbclid gclid dclid gbraid wbraid msclkid twclid ttclid yclid igshid igsh mc_cid mc_eid mc_tc " +
    "mkt_tok _hsenc _hsmi __hsfp __hssc __hstc hsCtaTracking vero_id vero_conv oly_anon_id " +
    "oly_enc_id _ga _gl srsltid cmpid ncid ref_src ref_url __twitter_impression wickedid " +
    "rb_clickid ml_subscriber ml_subscriber_hash s_cid triedRedirect isFreemail"
  ).split(" "),
);

const GLOBAL_PREFIX = ["utm_", "mtm_", "pk_", "ga_", "itm_", "otm_", "hsa_"];

// Matched against the host after `www.`/`m.`/`mobile.` strip, exact or as a suffix.
const PER_HOST: ReadonlyArray<readonly [hosts: string[], params: string[]]> = [
  [
    ["x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com"],
    ["s", "t", "cn", "src", "ref"],
  ],
  [["youtube.com", "youtu.be"], ["si", "feature", "pp", "kw", "app", "ab_channel", "t"]],
  [["spotify.com"], ["si", "nd", "dlsi", "context", "pi"]],
  [["medium.com"], ["source", "sk", "gi"]],
  [["podcasts.apple.com"], ["l", "uo", "at", "ct", "itscg", "itsct", "ls"]],
  [["nytimes.com"], ["smid", "referringSource"]],
  [["tiktok.com"], ["_r", "_t", "is_from_webapp", "sender_device", "web_id"]],
  [["reddit.com"], ["share_id", "rdt"]],
];

// Substack: only on Substack hosts, or on any host when `utm_source=substack` is present.
const SUBSTACK_PARAMS = ["r", "s", "publication_id", "post_id", "showWelcomeOnShare"];

const X_HOSTS = new Set(["x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com"]);
const X_STATUS = /^\/(?:i\/web\/status|i\/status|[A-Za-z0-9_]{1,15}\/status(?:es)?)\/(\d+)/;

// D-16, exactly. X and Instagram are out.
const MEDIA_HOSTS = [
  "youtube.com",
  "youtu.be",
  "music.youtube.com",
  "vimeo.com",
  "open.spotify.com",
  "spotify.link",
  "podcasts.apple.com",
  "music.apple.com",
  "overcast.fm",
  "pca.st",
  "pocketcasts.com",
  "soundcloud.com",
  "twitch.tv",
  "tiktok.com",
];

const MAX_WRAPPER_DEPTH = 3;

function onHost(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

// Drops a leading `m.` or `mobile.` (structure rule) and keeps `www.`.
function dropMobile(host: string): string {
  return host.replace(/^(?:m|mobile)\./, "");
}

function withoutWww(host: string): string {
  return host.replace(/^www\./, "");
}

function parse(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`canonicalize: unparsable URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`canonicalize: unsupported scheme: ${url.protocol}`);
  }
  return url;
}

function paramName(piece: string): string {
  const eq = piece.indexOf("=");
  const name = eq === -1 ? piece : piece.slice(0, eq);
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

// Filters the query on raw `&` pieces so kept params keep their order, case and encoding.
function stripQuery(search: string, host: string): string {
  const pieces = search.replace(/^\?/, "").split("&").filter((p) => p !== "");
  const params = new URLSearchParams(search);
  const drop = new Set<string>();
  for (const [hosts, names] of PER_HOST) {
    if (onHost(host, hosts)) names.forEach((n) => drop.add(n));
  }
  if (onHost(host, ["substack.com"]) || params.getAll("utm_source").includes("substack")) {
    SUBSTACK_PARAMS.forEach((n) => drop.add(n));
  }
  const kept = pieces.filter((piece) => {
    const name = paramName(piece);
    if (GLOBAL_EXACT.has(name) || drop.has(name)) return false;
    return !GLOBAL_PREFIX.some((p) => name.startsWith(p));
  });
  return kept.length ? `?${kept.join("&")}` : "";
}

// google.com/url, l.facebook.com/l.php and out.reddit.com carry their target in a param.
function wrapperTarget(url: URL, host: string): string | null {
  const q = url.searchParams;
  let target: string | null = null;
  if (host === "google.com" && url.pathname === "/url") target = q.get("q") ?? q.get("url");
  else if (host === "l.facebook.com" && url.pathname === "/l.php") target = q.get("u");
  else if (host === "out.reddit.com") target = q.get("url");
  if (!target) return null;
  try {
    const t = new URL(target);
    return t.protocol === "http:" || t.protocol === "https:" ? target : null;
  } catch {
    return null;
  }
}

function urlKey(stored: string, host: string, raw: string): DedupeKey {
  const bareHost = withoutWww(host);
  const tail = stored.slice(`https://${host}`.length);
  return {
    type: "url",
    bare: `https://${bareHost}${tail}`,
    www: `https://www.${bareHost}${tail}`,
    raw,
  };
}

function canonicalizeAt(raw: string, input: string, depth: number): Canonical {
  const url = parse(input);
  // WHATWG URL already lowercases the host; path case is left alone.
  const host = dropMobile(url.hostname);
  const bareHost = withoutWww(host);

  if (depth < MAX_WRAPPER_DEPTH) {
    const target = wrapperTarget(url, bareHost);
    if (target) return canonicalizeAt(raw, target, depth + 1);
  }

  if (X_HOSTS.has(bareHost)) {
    const m = X_STATUS.exec(url.pathname);
    if (m?.[1]) {
      const id = m[1];
      return { stored: `https://x.com/i/status/${id}`, dedupe: { type: "x", id }, kind: "x", media: false };
    }
  }

  let outHost = host;
  let path = url.pathname;
  let search = url.search;

  // YouTube: youtu.be/<id> and /shorts/<id> become youtube.com/watch?v=<id>.
  if (bareHost === "youtu.be" || bareHost === "youtube.com") {
    const id =
      bareHost === "youtu.be"
        ? /^\/([^/]+)/.exec(path)?.[1]
        : /^\/shorts\/([^/]+)/.exec(path)?.[1];
    if (id) {
      if (bareHost === "youtu.be") outHost = "youtube.com";
      path = "/watch";
      const rest = search.replace(/^\?/, "");
      search = `?v=${id}${rest ? `&${rest}` : ""}`;
    }
  }

  const query = stripQuery(search, withoutWww(outHost));
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "") || "/";
  const port = url.port ? `:${url.port}` : "";
  const stored = `https://${outHost}${port}${path}${query}`;

  const media = onHost(withoutWww(outHost), MEDIA_HOSTS);
  return {
    stored,
    dedupe: urlKey(stored, `${outHost}${port}`, raw),
    kind: media ? "media" : "page",
    media,
  };
}

// `raw` is already trimmed and length-checked by the router. Throws a plain Error on an
// unparsable URL or a non-http(s) scheme (the router rejects those first, so it's a bug).
export function canonicalize(raw: string): Canonical {
  const trimmed = raw.trim();
  return canonicalizeAt(trimmed, trimmed, 0);
}
