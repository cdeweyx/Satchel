# iOS Shortcut

The share-sheet Shortcut that saves a link to Satchel (D-7 in `docs/tech-plan.md`). The repo holds the generator and an unsigned template with placeholders only. Never put a real Worker URL or key in either.

- `build-shortcut.py`: writes `Satchel.unsigned.shortcut`. Run `python3 -I shortcut/build-shortcut.py` (optional arg: another output path). Same inputs give a byte-identical file.
- `Satchel.unsigned.shortcut`: the generated binary plist, committed. Read it with `plutil -p`. The root `.gitignore` ignores `*.shortcut`, but the template is already tracked, so plain `git add` stages a regenerated copy. Only a new `.shortcut` file needs `git add -f`.
- `glyph.txt` (from the brand step, optional): the icon. `key = value` lines, `#` comments: `glyph = <Shortcuts glyph number or bookmark>` and `color = <color name or number>`. Color names: red, darkorange, orange, yellow, green, teal, lightblue, blue, darkblue, violet, purple, pink, darkgray, gray, taupe. Without the file the generator uses the bookmark glyph in gray and says so.

- `npm run shortcut` (`scripts/shortcut.sh`): regenerates the template, checks its shape, signs it to `dist/Satchel.shortcut`, checks the signed file starts with `AEA1`, and runs gitleaks over this folder. The signed file is gitignored and never committed.

## Install on your iPhone

You need a Mac with the Shortcuts app, a network connection (signing needs it), [gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`), your deployed Worker's URL and your `SATCHEL_KEY`.

1. On the Mac, from the repo root:

   ```sh
   npm run shortcut
   ```

   It ends with `signed dist/Satchel.shortcut`. If signing fails, it prints the manual build steps (also below, under [Manual build](#manual-build-if-signing-fails)) and exits with an error.

2. AirDrop `dist/Satchel.shortcut` to your iPhone. It opens in Shortcuts on the Add Shortcut screen.

3. Fill in your Worker URL and key, one of two ways:

   - **Answer the questions on Add Shortcut.** The first asks for your Worker URL: the base only, like `https://satchel.<you>.workers.dev`, without `/save`. The second asks for your `SATCHEL_KEY`. Then tap **Add Shortcut**.
   - **Or edit the Shortcut afterward.** If the questions don't show, or you skipped them, add the Shortcut, then open it in the Shortcuts app to edit. The first Text box holds the Worker URL and the second holds the key. Replace whatever's in each (a placeholder like `WORKER_URL_PLACEHOLDER`, or nothing) with your own values.

4. Check it. In Safari, tap Share, then **Satchel**, then pick **Send to inbox**. You should see "Saved ✓" and a new row in Notion. A wrong or empty key shows "Satchel: not saved" with `unauthorized`, so fix the second Text box if you see that.

5. Optional: in any share sheet, scroll to the end of the action list, tap **Edit Actions…**, and move Satchel into Favorites so it sits near the top.

The menu matches the Chrome popup:

| Menu item | Status sent |
|---|---|
| Send to inbox | `later` |
| Mark as archived | `read` |
| Favorite | `favorite` |

### Re-signing

A signed file can be imported for about 13 months. That limit is on importing the file, not on running the Shortcut: once it's on your iPhone, it keeps working. To install it after that (on a new phone, say), run `npm run shortcut` again, AirDrop the new `dist/Satchel.shortcut`, and fill in your URL and key again. Do the same after changing the generator.

## What the Shortcut does

Shows in the share sheet for URLs, Safari pages, articles and text. Actions, in order (index in brackets):

1. [0] **Text**: `WORKER_URL_PLACEHOLDER`. Import question 1 fills it: the Worker's base URL, without `/save`.
2. [1] **Text**: `KEY_PLACEHOLDER`. Import question 2 fills it with `SATCHEL_KEY`. The question's default is empty, so a skipped prompt sends an empty key and gets a visible 401.
3. [2] **Replace Text**: in the URL text, replace the regex `/$` with nothing, so a trailing slash can't turn the request into `//save`.
4. [3] **Choose from Menu** "Save to Satchel": Send to inbox / Mark as archived / Favorite.
5. [4-12] Each item: **Text** `later` / `read` / `favorite`, then **Set Variable** `status`.
6. [13] **End Menu**.
7. [14] **Get Name** of Shortcut Input. Safari gives the page title; X and Mail give the URL, which the Worker treats as no title.
8. [15] **Get Contents of URL**: `<Updated Text>/save`, method `POST`, request body JSON `url` = Shortcut Input as URL, `title` = Name, `status` = `status`. One header: `x-satchel-key` = the key Text. `Advanced` and `ShowHeaders` are on, or the editor drops the method and headers.
9. [16] **Get Dictionary Value** `ok` from Contents of URL.
10. [17] **If** Dictionary Value (as Number) is 1. JSON `true` is 1; a missing `ok`, `false`, or a non-JSON body isn't.
11. [18] **Show Notification** "Satchel" / "Saved ✓".
12. [19] **Otherwise**.
13. [20] **Get Dictionary Value** `error` from Contents of URL.
14. [21] **If** Dictionary Value has any value.
15. [22] **Show Notification** "Satchel: not saved" / the `error` value.
16. [23] **Otherwise**.
17. [24] **Show Notification** "Satchel: not saved" / "unexpected response".
18. [25] **End If** (inner), [26] **End If** (outer).

So "Saved ✓" shows only for a JSON body with `ok: true`. A 404, 500, empty 405 or an HTML error page reads as not saved.

## Manual build (if signing fails)

If `shortcuts sign` won't produce a file, build the same Shortcut by hand on the iPhone in the Shortcuts app.

1. New Shortcut, rename it **Satchel**. In its settings (the ⓘ button), turn on **Show in Share Sheet**. Under Share Sheet Types keep only **URLs**, **Safari web pages**, **Articles** and **Text**.
2. Add **Text**, type your Worker base URL (no `/save`).
3. Add **Text**, paste your `SATCHEL_KEY`.
4. Add **Replace Text**. Find `/$`, replace with nothing, turn on **Regular Expression**, and set the input to the first Text.
5. Add **Choose from Menu**, prompt "Save to Satchel", items `Send to inbox`, `Mark as archived`, `Favorite`. Under each item add **Text** (`later`, `read`, `favorite`) and then **Set Variable** `status` to that Text.
6. After End Menu, add **Get Name** of Shortcut Input.
7. Add **Get Contents of URL**. URL: the Updated Text variable from step 4, then type `/save`. Expand it: Method **POST**, add one header `x-satchel-key` = the Text from step 3 (exactly one header row; an empty extra row breaks POSTs). Request Body **JSON** with three Text fields: `url` = Shortcut Input (tap it, set type to URL), `title` = Name, `status` = the `status` variable.
8. Add **Get Dictionary Value**, Get Value for `ok` in Contents of URL.
9. Add **If** Dictionary Value (tap it, set type to Number) **is** `1`.
10. Inside If: **Show Notification** "Saved ✓".
11. Inside Otherwise: **Get Dictionary Value** for `error` in Contents of URL, then **If** that Dictionary Value **has any value**: **Show Notification** "Satchel: not saved" with the Dictionary Value; Otherwise **Show Notification** "Satchel: not saved" with the text `unexpected response`.
12. Test with a wrong key first: share any page, expect "Satchel: not saved" / `unauthorized`. Then fix the key and expect "Saved ✓".
