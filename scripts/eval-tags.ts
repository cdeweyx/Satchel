// Scores Claude's tags against hand-tagged rows (SAT-40). Dev tool, not part of the Worker.
//
//   tmp=$(mktemp) && chmod 600 "$tmp" && grep -E '^ANTHROPIC_API_KEY=' ~/.config/satchel/secrets.env > "$tmp" \
//     && (set -a; . "$tmp"; set +a; node --experimental-transform-types scripts/eval-tags.ts <eval.jsonl> <tags.json>); rm -f "$tmp"
//
// eval.jsonl: one {title, url, tags} per line. tags.json: the allowed tag names.
// Calls the real cleanTitleAndTags from src/claude.ts (same prompt, same request) with the
// `titled` shape, at most 3 at a time, and prints a summary plus a per-row table.
// Never prints the key. Real calls cost a fraction of a cent each.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

// src/ uses extensionless relative imports (bundler resolution). Node needs the .ts, so
// add it here instead of changing src/. The transform flag (not just type stripping) is for
// the parameter properties in src/claude.ts.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        // fall through to the default
      }
    }
    return next(specifier, context);
  },
});

type Row = { title: string; url: string; tags: string[] };

const [evalPath, tagsPath] = process.argv.slice(2);
if (!evalPath || !tagsPath) {
  console.error("usage: node --experimental-transform-types scripts/eval-tags.ts <eval.jsonl> <tags.json>");
  process.exit(2);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(2);
}

const rows: Row[] = readFileSync(evalPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Row);
const allowedTags = JSON.parse(readFileSync(tagsPath, "utf8")) as string[];

const { cleanTitleAndTags } = await import("../src/claude.ts");
const env = { ANTHROPIC_API_KEY: apiKey } as unknown as Env;

const CONCURRENCY = 3;
const results: (string[] | null)[] = new Array(rows.length).fill(null);
let next = 0;
async function worker(): Promise<void> {
  while (next < rows.length) {
    const i = next++;
    const row = rows[i]!;
    const out = await cleanTitleAndTags(
      env,
      { shape: "titled", title: row.title, url: row.url },
      allowedTags,
      new AbortController().signal,
    );
    results[i] = out ? out.tags : null;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

let exact = 0;
let truePos = 0;
let predicted = 0;
let gold = 0;
let failed = 0;
const matched: boolean[] = new Array(rows.length).fill(false);
for (const [i, row] of rows.entries()) {
  const got = results[i];
  gold += row.tags.length;
  if (got === null) {
    failed++;
    continue;
  }
  const want = new Set(row.tags);
  const have = new Set(got);
  predicted += have.size;
  const hits = [...have].filter((t) => want.has(t)).length;
  truePos += hits;
  if (hits === want.size && hits === have.size) {
    exact++;
    matched[i] = true;
  }
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const scored = rows.length - failed;
console.log(`Rows: ${rows.length} (${failed} failed calls, scored as misses)`);
console.log(`Exact match: ${exact}/${rows.length} (${pct(exact, rows.length)})`);
console.log(`Tag precision: ${truePos}/${predicted} (${pct(truePos, predicted)})`);
console.log(`Tag recall: ${truePos}/${gold} (${pct(truePos, gold)})`);
console.log(
  `Avg tags per row: Claude ${scored === 0 ? "n/a" : (predicted / scored).toFixed(2)}, user ${rows.length === 0 ? "n/a" : (gold / rows.length).toFixed(2)}`,
);
console.log("");
console.log("| Title | User | Claude | Match |");
console.log("| --- | --- | --- | --- |");
for (const [i, row] of rows.entries()) {
  const got = results[i];
  const cell = (s: string) => s.replaceAll("|", "\\|");
  console.log(
    `| ${cell(row.title)} | ${row.tags.join(", ")} | ${got === null ? "(failed)" : got.join(", ")} | ${matched[i] ? "yes" : ""} |`,
  );
}
