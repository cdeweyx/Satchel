# Lane 5: iOS Shortcut as a generated, signed file (2026-11-07)

## Answer

- **Yes, the whole path works on this Mac.** A Python script writes the unsigned binary plist with placeholder URL and key, `shortcuts sign --mode anyone` signs it in about 4 seconds with exit 0, and the output is a real AEA archive (`AEA1` magic, Apple cert chain in the header). The Mac Shortcuts app accepted the signed file and offered "Add Shortcut…" (probe, see below). The repo keeps only the generator and the unsigned template; neither holds a key.
- **Install prompts for URL and key via `WFWorkflowImportQuestions`.** The key shape is documented (ActionIndex, Category "Parameter", ParameterKey, Text, DefaultValue) and Apple still documents import questions in the current iOS guide. Whether iOS 26 actually asks them when importing a *signed file* is the one thing I couldn't verify without a phone. Fallback if it doesn't: the key lives in a Text action at the top of the shortcut and the README says "edit the first two boxes."
- **Signing needs the network.** Each `shortcuts sign` run gets a fresh leaf certificate from Apple (different serial, notBefore = the second you ran it). Apple's own doc says Apple receives a copy for validation. With outbound network denied in a sandbox the command fails with "Operation not permitted"; the same sandbox with network allowed passes. No iCloud login is needed for `--mode anyone`.
- **The signing cert is valid for ~13 months** (notAfter Dec 2027 for a file signed today). Whether iOS refuses an import after that is unverified. Cheap insurance: never commit the signed file, re-sign on release, and treat "re-sign and re-AirDrop" as the month-13 fix.
- **Title: send it when you have it, let the Worker decide.** From Safari the share sheet passes a Safari web page item whose Name is the page title. From X and Mail you get a bare URL and Name equals the URL. The shortcut always sends `title`; the Worker treats `title` empty or equal to `url` as missing and does its own lookup.
- **Error handling is a branch on the response body**, not the status code. The Worker should return JSON with an `error` key on any failure (and keep real 4xx/5xx codes). The shortcut reads `error`; if it has a value it shows "Satchel: not saved" with the message, else "Saved ✓". Offline, Shortcuts itself throws a network error alert before either notification, so a false "Saved ✓" can't happen.

## Verified table

| Claim | Rung | Result | Source | Decision it feeds |
|---|---|---|---|---|
| Unsigned `.shortcut` is a binary plist with `WFWorkflowActions`, `WFWorkflowTypes`, `WFWorkflowInputContentItemClasses`, `WFWorkflowImportQuestions` | repo + probe | Generated plist lints clean, `file` says "Apple binary property list" | sebj/iOS-Shortcuts-Reference README (fetched 2026-11-07); `.context/probes/shortcut/gen.py` | Generate in repo |
| `shortcuts sign --mode anyone` works on macOS 26.6.2 | probe | exit 0, 3.7 s, 23.8 KB output | `.context/probes/shortcut/Satchel-signed.shortcut` | Sign on Mac, not manual build |
| Signed output is an AEA archive | probe | Header `AEA1`, profile 0, 2203-byte auth data holding `SigningCertificateChain` (3 DER certs: leaf, Apple System Integration CA 4, Apple Root CA G3). `aea id` prints an identifier | probe shell, 2026-11-07 | Validity check in CI: assert first 4 bytes are `AEA1` |
| Signed file is accepted by Shortcuts.app | probe | Opening it on the Mac showed the import sheet "Satchel-signed / Add Shortcut… / Appears in Share Sheet" (not added; dialog closed). An import dialog appearing is itself evidence the signature verified | probe, 2026-11-07 | Same file will install on iPhone (iOS verification unverified, see below) |
| Signing contacts Apple and needs network | probe + doc | Two consecutive signs produced leaf certs with different serials and notBefore 02:41:15 vs 02:42:15 UTC. Sandbox with `(deny network-outbound (remote ip "*:*"))` fails "Operation not permitted"; sandbox with no deny passes. Apple: "When you sign a shortcut, Apple receives a copy for validation" | Apple "Run shortcuts from the command line" (macOS 27 guide, fetched 2026-11-07); probe | Month-three question: sign only on a Mac that's online |
| Signing cert lifetime | probe | Leaf notAfter = Dec 1 2027 (about 13 months) | openssl on extracted cert, 2026-11-07 | Re-sign on each release; don't commit the signed file |
| `--mode anyone` needs no iCloud account | probe | `shortcuts list` shows 0 shortcuts on this Mac (library empty, no Shortcuts iCloud state) and signing still succeeded | probe | CI on any Mac works |
| Placeholders survive in unsigned file, invisible in signed file | probe | `plutil -p` finds 3 placeholder hits in unsigned; `strings` finds 0 in signed (payload encrypted) | probe | Repo copy = unsigned template + generator |
| Action identifiers: `is.workflow.actions.downloadurl` (WFURL, WFHTTPMethod, WFHTTPBodyType JSON, WFJSONValues, WFHTTPHeaders, Advanced, ShowHeaders), `choosefrommenu` (WFControlFlowMode 0/1/2, GroupingIdentifier, WFMenuPrompt, WFMenuItems, WFMenuItemTitle), `notification` (WFNotificationActionTitle/Body/Sound), `detect.link`, `getitemname`, `getvalueforkey` (WFDictionaryKey, WFGetDictionaryValueType) | repo | All confirmed in shortcuts-js sources | github.com/joshfarrant/shortcuts-js `src/actions/*.ts` (fetched 2026-11-07) | Generator |
| `WFCondition` integer codes: is 4, is not 5, has any value 100, no value 101, contains 99 | repo | Cherri `shortcut.go` `conditions` map | github.com/electrikmilk/cherri `shortcut.go` lines 342-356 (fetched 2026-11-07) | Error branch |
| `WFWorkflowTypes: ["ActionExtension"]` = Show in Share Sheet; input classes `WFURLContentItem`, `WFSafariWebPageContentItem`, `WFArticleContentItem`, `WFStringContentItem` are valid values | repo | Listed in sebj reference | sebj README (fetched 2026-11-07) | Share-sheet input |
| Import questions still exist and are shown "when the recipient runs the shortcut" | doc | Apple's current guide (iOS 27 era) documents Setup → Add New Question; sharing page says a shared file shows a description and "Add Shortcut" | Apple "Add import questions" guide and "Share shortcuts on iPhone" guide (both fetched 2026-11-07) | Install path |
| Import questions had an authoring bug on iOS 18.5 / macOS 15.5 (couldn't add new ones in the app; existing ones kept working) | doc | Apple Community thread, posts May 16 to Jun 3 2025 | discussions.apple.com/thread/256061654 | Risk note: generate questions in the plist, don't author them in the app |
| "Allow Untrusted Shortcuts" is gone; iOS 15+ has "Private Sharing" for contacts-only sharing | doc | Apple's privacy settings guide (iOS 27 era) names only Private Sharing, which gates "people who know me" shares. A `--mode anyone` file needs no setting | Apple "Adjust basic privacy settings" guide (fetched 2026-11-07); iDownloadBlog via search | Install path: AirDrop, tap Add Shortcut |

## Recommendation per decision

- **Generate the shortcut from a script in the repo (one-way: it's the whole point of "repo holds no key").** `scripts/build-shortcut.py` writes `shortcut/Satchel.unsigned.shortcut` with placeholders, then `shortcuts sign --mode anyone` writes `dist/Satchel.shortcut` (gitignored). Runner-up: hand-build in the app and export; rejected because the exported file is signed and opaque, so reviewers can't see what's in it and a key could leak invisibly.
- **Prompt for URL and key with import questions, with a Text-action fallback (two-way).** Questions point at actions 0 and 2 (`WFTextActionText`). If the phone doesn't ask on import, the user edits the two Text boxes at the top of the shortcut; README documents both. Runner-up: "Ask for Input" at runtime each save; rejected, it's a tap per save.
- **Always send `title`; Worker ignores it when empty or equal to `url` (two-way).** `getitemname` on the share-sheet input gives the Safari page title for free and the URL string for X/Mail. Runner-up: never send a title and always fetch server-side; rejected because Safari's title is the best signal for paywalled or JS-heavy pages the Worker can't fetch.
- **Error branch on an `error` key in the JSON body (two-way).** Worker returns `{ "ok": true, "id": ... }` or `{ "ok": false, "error": "..." }` with proper status codes. Shortcut: Get Dictionary Value `error` → If has any value → notification "Satchel: not saved" + message, Otherwise "Saved ✓". Runner-up: Get Headers of URL to read the status code; rejected, it's a second request.
- **Install by AirDrop of the `--mode anyone` file (one-way for v1).** No setting needed on iOS 15+. Runner-up: iCloud link; rejected because it requires the Mac's Shortcuts library and iCloud sync.
- **Don't commit the signed file. Sign on release and re-sign if an import ever fails (two-way).** Cert lives ~13 months; a `make shortcut` target hides the step.

## Gotchas

- **Exact plist shapes** (all in `.context/probes/shortcut/gen.py`, copy into the repo script):
  - Inline variable in text: `{"Value": {"string": "￼/save", "attachmentsByRange": {"{0, 1}": {"Type": "Variable", "VariableName": "WorkerURL"}}}, "WFSerializationType": "WFTextTokenString"}`.
  - Share-sheet input attachment: `{"Type": "ExtensionInput"}` inside a `WFTextTokenAttachment`.
  - Action output reference: `{"Type": "ActionOutput", "OutputUUID": "<UUID of that action>", "OutputName": "Contents of URL"}`; give the producing action a `UUID` key.
  - Headers and JSON body are `WFDictionaryFieldValue` with `WFDictionaryFieldValueItems`, each `{"WFItemType": 0, "WFKey": <text>, "WFValue": <text>}`.
  - `downloadurl` needs `Advanced: true` and `ShowHeaders: true` or the method/headers are ignored in the editor.
  - Conditional `WFInput` is `{"Type": "Variable", "Variable": <WFTextTokenAttachment>}` (one more nesting level than other actions).
  - Menu and If are three actions each (mode 0 start, 1 per item / else, 2 end) sharing one `GroupingIdentifier`.
- **Header name**: `x-satchel-key`, lowercase, as a dictionary key in `WFHTTPHeaders`. Known Shortcuts bug: a stray empty header row breaks POSTs (Apple Community, 2025). The generator writes exactly one row.
- **Top-level keys**: `WFWorkflowClientVersion` string, `WFWorkflowMinimumClientVersion` 900 int plus `WFWorkflowMinimumClientVersionString` "900", `WFWorkflowHasShortcutInputVariables` true, `WFWorkflowTypes ["ActionExtension"]`, `WFWorkflowOutputContentItemClasses []`.
- **Import question `DefaultValue`** for the key is `""` so a skipped prompt leaves an empty key and the Worker's 401 lights the error branch instead of silently saving nothing.
- **Signing exit codes**: 0 success, 1 error. "The file couldn't be opened because it isn't in the correct format" means the input plist is malformed (I hit it with a generator bug). "The operation couldn't be completed. Operation not permitted" was the offline-sandbox error.
- **Validity check for CI**: `head -c4 dist/Satchel.shortcut` must be `AEA1`; `aea id -i` must print a hash. The payload is encrypted, so don't try to grep the signed file for secrets; grep the unsigned one instead and run gitleaks on it.
- **Don't `open` the signed file on the Mac in automation.** It pops a modal import sheet in Shortcuts.app (happened once in this probe; closed, nothing imported).
- **Filename becomes the shortcut name** on import ("Satchel-signed" appeared). Name the output `Satchel.shortcut`.

## Still unverified

- **Import questions asked on iOS 26 when installing a signed `--mode anyone` file** (needs device probe). Apple documents the feature; the Mac sheet showed "Add Shortcut…" with an ellipsis, consistent with a setup step, but I didn't click it. If they don't fire, use the Text-action fallback above.
- **`Get Contents of URL` on 4xx/5xx returns the body rather than halting** (needs device probe; no Apple doc covers it). Either way no false "Saved ✓" is possible: if it halts, the user sees Shortcuts' own error alert. Day-one test: save with a wrong key, expect "Satchel: not saved: unauthorized".
- **Offline behaviour**: expect Shortcuts' system alert ("The Internet connection appears to be offline"), which stops the run before any notification (needs device probe).
- **Whether iOS rejects a file whose signing cert has expired** (~13 months). Needs a probe in Dec 2027 or a re-sign habit. Re-signing is free, so plan for it rather than test it.
- **Safari share sheet passes `WFSafariWebPageContentItem` whose Name is the page title, X and Mail pass a bare URL** (needs device probe; it's the standard behaviour but unproven here). The "title equals url means missing" Worker rule makes both cases safe.

## Dead ends

- `sandbox-exec` with `(deny network*)` also blocks local XPC, so it can't distinguish "needs internet" from "needs a daemon". The remote-IP-only deny plus the control run is the clean test.
- `log show` for the `shortcuts` process returned nothing useful in 5 minutes.
- shortcuts-js `conditional.ts` uses the iOS 12 string conditions ("Equals"); use Cherri's integer codes.
- GitHub code search needs auth; fetched Cherri files directly instead.

## What this means for the step that asked

Build order item 4 is a script plus one `make` target, not a GUI chore. The build agent should: port `gen.py` to the repo (same actions, real Worker response contract `{ok, error?}`), gitignore `dist/`, add a CI check for the `AEA1` header on the unsigned → signed step, and write the README's two install paths (import questions, or edit the two Text boxes). The first phone test should deliberately use a bad key to see the failure notification before testing the happy path.
