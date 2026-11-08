# Satchel brand: The Maker's Stamp

Every good satchel carries a maker's mark pressed into the flap. Saving a link is pressing the stamp: one color, one impression, done.

Source of truth: the [Final page](https://app.paper.design/file/01M6WXXRTZF9VAQA14M8AXNMZ1/p-3-0) in the Paper file "Satchel". Every value here was read off that board with Paper's computed styles. The extension takes them from `extension/tokens.css`, the only file under `extension/` that holds a hex value.

## Palette

| Role | Token | Light | Dark | Used on |
|---|---|---|---|---|
| Ground | `--satchel-bg` | `#F4F1EB` flax paper | `#1E1A16` dark saddle | The popup and options page |
| Ink | `--satchel-fg` | `#1E1A16` | `#EDE7DD` | Titles, labels, keycap letters |
| Muted | `--satchel-muted` | `#6B6157` | `#A89C8C` | The domain line, the footer hint |
| Rule | `--satchel-rule` | `#C9C0B2` | `#3C342C` | Dividers and the 1px keycap stroke |
| Stamp blue | `--satchel-accent` | `#2F4DA0` | `#8AA2E6` | The mark, a pressed keycap, the SAVED impression. Nothing else. |
| Brass | `--satchel-favorite` | `#B5883A` | `#B5883A` | The star, once it's set |
| Error | `--satchel-danger` | `#1E1A16` | `#EDE7DD` | Error text. It's the ink, never red. |

Contrast against the ground (WCAG 2.2):

| Pair | Light | Dark |
|---|---|---|
| Ink on ground | 15.34 | 14.06 |
| Muted on ground | 5.36 | 6.42 |
| Stamp blue on ground | 6.92 | 6.91 |
| Ground on stamp blue (pressed keycap) | 6.92 | 6.91 |
| Error on ground | 15.34 | 14.06 |
| Brass on ground (a graphic, not text) | 2.85 | 5.39 |

Every text pair clears AA (4.5). Brass on flax sits just under the 3:1 bar for graphics, so the set star shouldn't carry meaning alone. Pair it with the word Favorite.

Keep the blue cold and the ground grayer than cream. A warm accent or any texture drifts this toward artisanal coffee.

## Type

- **Hanken Grotesk** (`--satchel-font`) carries all text. Page title 600 / 16 px, line 21, tracking -0.01em. Row labels 400 / 14 px, line 20 (`--satchel-font-size`). The domain line and footer 400 / 12 px, line 16.
- **Besley 800** (`--satchel-font-display`) appears only inside the stamp: the wordmark and the SAVED impression. Titles stay grotesk.
- **IBM Plex Mono** (`--satchel-font-mono`) for keycaps: 500 / 12 px in a 22 px cap, 400 / 10 px for the `esc` cap.

All three are OFL and bundled as latin woff2 in `extension/fonts/` with each family's `OFL-*.txt`. Hanken Grotesk ships as one variable file covering 400 to 600.

## Radius

`--satchel-radius` is 6 px: action rows and the framed mark. Keycaps use 5 px (4 px for `esc`), and the popup panel is 10 px.

## The mark

`brand/mark.svg` is the die plate, 390 by 100, in stamp blue only:

- An outer rule 3 px wide with a 16 px corner.
- A 5 px gap, then an inner rule 1 px wide with a 10 px corner.
- SATCHEL in Besley 800 at 52 px, tracking 0.04em, 30 px in from each side, 14 px from the top and 12 px from the bottom. The letters are outlined to paths, so the mark needs no font.

On light it's printed flat. On dark saddle the large die is debossed (shadow only, no ink).

The README is the exception: it uses `brand/mark-dark.svg` (the same paths in #8AA2E6) on dark, because an `<img>` can't cast the debossed shadow.

The icon is the same die with just an S. It's built per size so it holds up at 16 px:

- **48 and 128 px**: outer rule 3 px (corner 9), inner rule 1 px at a 6 px inset (corner 5.5), S at 26 px on the 48 px grid. The 128 is the 48 drawn larger.
- **32 px**: outer rule 2 px (corner 6), inner rule 1 px at 4 px (corner 3.5), S at 18 px.
- **16 px**: one 1.5 px rule (corner 3.25), S at 11 px. The inner rule drops out.

Unlike the wordmark, the icon's plate is filled with flax inside the outer rule, so it reads as a small flax stamp on light and dark toolbars alike. Transparent, the blue die was 2.21:1 on dark saddle. Filled, the plate is 15.34:1 against dark saddle and the blue sits on flax at 6.92:1. PNGs live in `extension/icons/icon-{16,32,48,128}.png`. The Shortcut uses the bag glyph on Shortcuts' dark blue, the closest it offers to stamp blue (`shortcut/glyph.txt`).

## The save beat

The whole beat finishes in 600 ms. No toast, no checkmark.

1. The pressed keycap fills stamp blue.
2. A SAVED plate (Besley 800 / 14 px, tracking 0.08em, a 2 px rule around a 1 px rule, tilted -4°) drops 2 px in 120 ms, ease-out.
3. A 60 ms ink spread settles it.
4. The popup closes at 600 ms, a beat to enjoy SAVED.

## Keyboard

| Key | Does |
|---|---|
| `L` | Send to inbox |
| `R` | Mark as archived |
| `F` | Favorite. It's a follow-on: after `R`, a Favorite row slides in for 3 s. Any other key closes. |
| `esc` | Close |
| `?` | Show the keys |

Keycaps sit at the right edge of each row: a 1 px `--satchel-rule` stroke, the letter in Plex Mono.

## Copy

- American spelling everywhere, in docs and in the product: favorite, color, gray.
- The follow-on row says just "Favorite". Never "Also favorite", never "favourite".
- Labels are sentence case ("Send to inbox"). Saved page titles are Title Case.
- An error keeps its row and swaps the label ("Couldn't save, try again"). The keycap outline turns ink. No red.
