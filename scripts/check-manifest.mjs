#!/usr/bin/env node
// Asserts extension/manifest.json has the shape D-13 needs. Runs inside `npm run check`.
// Prints every problem, then exits 1 if there were any.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const manifestPath = join(extensionDir, "manifest.json");

const problems = [];
const fail = (msg) => problems.push(msg);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`check-manifest: can't read ${manifestPath}: ${err.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail(`manifest_version is ${manifest.manifest_version}, want 3`);
if (!manifest.action?.default_popup) fail("action.default_popup is missing");
if (!manifest.options_page) fail("options_page is missing");
if (!manifest.background?.service_worker) fail("background.service_worker is missing");

const want = ["storage", "activeTab"];
const got = manifest.permissions;
if (!Array.isArray(got) || got.length !== want.length || want.some((p, i) => got[i] !== p)) {
  fail(`permissions is ${JSON.stringify(got)}, want exactly ${JSON.stringify(want)}`);
}
// CORS is the Worker's job (D-4); the extension asks for no host access.
for (const key of ["host_permissions", "optional_host_permissions"]) {
  if (key in manifest) fail(`${key} must not be present`);
}

if (!manifest.commands?._execute_action) fail("commands._execute_action is missing");

for (const size of ["16", "32", "48", "128"]) {
  const rel = manifest.icons?.[size];
  if (!rel) {
    fail(`icons.${size} is missing`);
  } else if (!existsSync(join(extensionDir, rel))) {
    fail(`icons.${size} points at extension/${rel}, which doesn't exist`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`check-manifest: ${p}`);
  process.exit(1);
}
console.log("check-manifest: ok");
