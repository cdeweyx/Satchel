# iOS Shortcut

The share-sheet Shortcut that saves a link to Satchel (D-7 in `docs/tech-plan.md`). The repo holds the generator and an unsigned template with placeholders only. Never put a real Worker URL or key in either.

- `build-shortcut.py`: writes `Satchel.unsigned.shortcut`. Run `python3 -I shortcut/build-shortcut.py` (optional arg: another output path). Same inputs give a byte-identical file.
- `Satchel.unsigned.shortcut`: the generated binary plist, committed. Read it with `plutil -p`. The root `.gitignore` ignores `*.shortcut`, but the template is already tracked, so plain `git add` stages a regenerated copy. Only a new `.shortcut` file needs `git add -f`.
- `glyph.txt` (from the brand step, optional): the icon. `key = value` lines, `#` comments: `glyph = <Shortcuts glyph number or bookmark>` and `color = <colour name or number>`. Colour names: red, darkorange, orange, yellow, green, teal, lightblue, blue, darkblue, violet, purple, pink, darkgray, gray, taupe. Without the file the generator uses the bookmark glyph in gray and says so.

Signing (`shortcuts sign --mode anyone`) and install docs land in M4 (SAT-25). The signed file is never committed.

## What the Shortcut does

Shows in the share sheet for URLs, Safari pages, articles and text. Actions, in order (index in brackets):

1. [0] **Text**: `WORKER_URL_PLACEHOLDER`. Import question 1 fills it: the Worker's base URL, without `/save`.
2. [1] **Text**: `KEY_PLACEHOLDER`. Import question 2 fills it with `SATCHEL_KEY`. The question's default is empty, so a skipped prompt sends an empty key and gets a visible 401.
3. [2] **Replace Text**: in the URL text, replace the regex `/$` with nothing, so a trailing slash can't turn the request into `//save`.
4. [3] **Choose from Menu** "Save to Satchel": Later / Read / ★ Favorite.
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

If `shortcuts sign` won't produce a file, build the same Shortcut by hand on the iPhone in the Shortcuts app. About 10 minutes.

1. New Shortcut, rename it **Satchel**. In its settings (the ⓘ button), turn on **Show in Share Sheet**. Under Share Sheet Types keep only **URLs**, **Safari web pages**, **Articles** and **Text**.
2. Add **Text**, type your Worker base URL (no `/save`).
3. Add **Text**, paste your `SATCHEL_KEY`.
4. Add **Replace Text**. Find `/$`, replace with nothing, turn on **Regular Expression**, and set the input to the first Text.
5. Add **Choose from Menu**, prompt "Save to Satchel", items `Later`, `Read`, `★ Favorite`. Under each item add **Text** (`later`, `read`, `favorite`) and then **Set Variable** `status` to that Text.
6. After End Menu, add **Get Name** of Shortcut Input.
7. Add **Get Contents of URL**. URL: the Updated Text variable from step 4, then type `/save`. Expand it: Method **POST**, add one header `x-satchel-key` = the Text from step 3 (exactly one header row; an empty extra row breaks POSTs). Request Body **JSON** with three Text fields: `url` = Shortcut Input (tap it, set type to URL), `title` = Name, `status` = the `status` variable.
8. Add **Get Dictionary Value**, Get Value for `ok` in Contents of URL.
9. Add **If** Dictionary Value (tap it, set type to Number) **is** `1`.
10. Inside If: **Show Notification** "Saved ✓".
11. Inside Otherwise: **Get Dictionary Value** for `error` in Contents of URL, then **If** that Dictionary Value **has any value**: **Show Notification** "Satchel: not saved" with the Dictionary Value; Otherwise **Show Notification** "Satchel: not saved" with the text `unexpected response`.
12. Test with a wrong key first: share any page, expect "Satchel: not saved" / `unauthorized`. Then fix the key and expect "Saved ✓".
