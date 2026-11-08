# Ledger: M0 Walking Skeleton

Started 2026-11-07. Direct mode: issue PRs into `main`, lead merges on Ready. No milestone branch. Demo script `docs/build/demo-M0.md` (drafted in `.context/demo-M0.md`, lands with the close). Ledger lives in `.context/` until the close PR.

## Issues

| Keys | Title | Squash sha | Lines | Check time | Approach | Review rounds | Notes |
|---|---|---|---|---|---|---|---|
| SAT-1 | Scaffold Worker repo, harness and guardrails | 9c1921d | ~20.8k diff (mostly lockfile + generated types) | 2.45 s | Large: readiness 22 choices/11 refs ruled; approach 1 round, sound with changes (secrets.required → deploy.sh, catch-all reset proof) | 1 (Ready, 2 P2 carried) | merge.sh `--delete-branch` fails in a worktree after merging; remote branch deleted by hand |
| SAT-8 | X title via oEmbed + Twitterbot | ac36c81 | ~580 diff | ~2 s | not flagged | 1 (Ready, 1 P2) | started before M0 close (ruling) |
| SAT-10 | Page titles via HTMLRewriter | 194719c | ~450 diff | ~2 s | not flagged | 1 (Ready, 0) | P2s parked |
| SAT-9 | Media titles via oEmbed | (main) | ~320 diff | ~7 s (real 4 s timeout test) | not flagged | 1 (Ready, 2 P2) | TikTok oEmbed no longer has titles → SAT-12 falls through to page |
| SAT-6 | Save handler | eb8de5a | ~890 diff | ~5 s | Large: readiness 6/6 ruled; 2 concerns ruled before review (X exact id, & for query URLs) | 1 (Ready, 1 P2 carried to SAT-12) | D-2 status line |
| SAT-13 | Schema cache and tag guard | 5557298 | ~290 diff | ~8 s | not flagged | 1 (Ready, 3 P2) | M2, started early |
| SAT-14 | Claude client | 7bbec2f | ~720 diff (lockfile) | ~8 s | not flagged | 1 (Ready, 0) | apiKey sends Bearer on SDK 1.6.0; research doc stale |
| SAT-12 | Enrich stage 1 | 0339b49 | ~860 diff | ~12 s | not flagged; 3 concerns ruled before review | 2 (2 P2 fixed: my regex ruling was wrong) | live: X/YouTube/page titles land within 4 s |
| SAT-16 | Keyed /health probes | 5256e11 | ~440 diff | ~15 s | not flagged | 1 (Ready, 0) + README conflict merge | live keyed /health all ok; personal key works on /v1/models |
| (harness) | merge.sh: delete remote branch directly | d940ff7 | 3 | n/a | not flagged | 1 (Ready) | Lead-applied harness fix, PR #5 |
| SAT-5 | Fallback title | (see main) | 251 diff | ~2 s | not flagged; ruled 2 concerns before review (strip page extensions; sentence case stays) | 1 (Ready, 0 findings) | Signature takes raw URL (ruling) |
| SAT-3 | Notion client with no retry | e575beb | ~700 diff | ~2 s | not flagged | 1 (Ready, 2 P2 carried to SAT-6) | 6 mutation runs by reviewer all caught |
| SAT-2 | Canonicalize URLs | 3f427c0 | ~500 diff | ~2 s | not flagged | 1 (Ready, 0) | L3 expected → dedupe.bare (keep-www rule) |
| SAT-4 | Router, auth, CORS, JSON contract | fa4d3f3 | ~420 diff | ~1 s | not flagged | 2 (P1 OPTIONS /health fixed) | Ruling: OPTIONS /health added to D-4 (plan gap; Test button preflight) |

## Rulings

- 2026-11-07 SAT-1 Ruling: ledger and demo script live in `.context/` during M0 and land in `docs/build/` with a small close PR, because direct mode has no milestone branch to carry lead doc edits; cost if wrong: none (local file).
- 2026-11-07 SAT-1 Ruling: real Notion IDs stay out of the repo (`wrangler.jsonc` holds `set-at-deploy`, SAT-7 passes them at deploy), because handoff says never commit any of the five values and the repo goes public in M6; cost if wrong: one extra deploy flag.
- 2026-11-07 SAT-1 Ruling: HealthResponse is D-4's flat shape, not a checks map; cost if wrong: SAT-16 reshapes a type.
- 2026-11-07 SAT-1 Ruling: Stop hook skips (doesn't block) when `node_modules` is missing or `stop_hook_active`; cost if wrong: a fresh worktree ends a turn unchecked.

- 2026-11-07 SAT-31 (M2b, run in parallel): user approved 74 ("the 74 is good"); Articles Tags had 34 not 32 (Interviews, Learning existed), 40 added; original 34 and 5 Archived rows verified unchanged from snapshots in `.context/sat-31/`. Done.

- 2026-11-07 Ruling (user: "be pragmatic... personal tool"): from SAT-2 on, no readiness reads or approach reviews (one cold read for Large SAT-6), one combined reviewer per PR, validator only for P0, P2s logged not fixed, SAT-2..5 built in parallel, lead's check run on head is the stamp. Data and secrets guardrails stay at full weight.

- 2026-11-08 SAT-4 Ruling: add `OPTIONS /health` → 204 (`GET, OPTIONS`) to the D-4 contract, because D-13's Test button sends a keyed GET from an extension origin and Chrome preflights it; cost if wrong: none (additive).
- 2026-11-08 SAT-35 filed: living README on user ask; standing rule in CLAUDE.md + PR rules.

- 2026-11-08 Ruling: SAT-8/9/10 (M1 lookups) start before M0 closes, because they need only the scaffold and touch only new files under src/title/; README layout for src/title/ lands with SAT-12 to avoid parallel README conflicts; cost if wrong: a rebase-free merge of main into a lookup branch.
- 2026-11-08 SAT-6 readiness: 6 choices, 6 refs ruled (waitUntil gets a non-rejecting copy; root-URL clause; router.test.ts 500→502 expectations; boundary test made non-vacuous with an enrich that PATCHes).
- 2026-11-08 SAT-6 Ruling: dedupe refinements to D-2 (X hits post-filtered to exact id; query-bearing stored URL uses starts_with + "&"; bare root uses slashless form), because the plan's literal rule matched longer X ids and missed old YouTube rows with extra params; cost if wrong: a few missed dedupes, caught at SAT-7's real curls.

## Parked

- Created-then-timeout on the sync create: client sees 502, the row exists, re-save is a hit, no enrich (D-10 accepted). Reopens if M5 rows show fallback titles that never got enriched.

- PR12 P2s (SAT-10 page titles): timeout after <title> but before </head> returns null (drops a title already read); stray Uncaught AbortError log on abort. Reopen if M1's debug-route table (SAT-11) shows slow pages losing titles.

## Gates

- SAT-7 (deploy gate), 2026-11-08: lead ran deploy and all curls green (see SAT-7 comment); registered the account's workers.dev subdomain via API (`satchel` was taken). User, 2026-11-08: "Can confirm it says true" (work profile reaches `/health`). Developer mode check moved to SAT-22. M0 closed.

## For the skill

- Readiness read on SAT-1 found 22 choices / 11 refs; brief pointed at a "S-x.y" key scheme from the plan draft that Linear renamed. Tech-planning should file briefs with SAT keys.
- SAT-31 drafter counted the issue's "32 existing" without checking; the live schema had 34. Briefs that cite a live count should say "about" or have the worker re-count first.
- 2026-11-07 SAT-31: user asked for random colors on the 40 new options; recolored in place (ids kept), verified.
- Lead rulings that widen a pattern (SAT-12 media-only regex) need one counterexample checked before sending; the reviewer found a real-post false positive the ruling introduced.
- Lead's merge one-liner chained cleanup with `;` after merge.sh, so a failed merge (README conflict, PR18) still removed the worktree and the implementer could no longer be resumed. Gate cleanup on merge.sh's exit code. Parallel PRs that each edit README Status conflict once one lands: expect a merge-main round per parallel README edit.
