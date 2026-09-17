# Letter IRL brand assets

The SVG masters and PNG exports below were delivered by the design tool (Aug 23, 2026) as
part of the widget design package. **All of those variants are generated from the same
source — never hand-recolor one.** If a new size or color is needed, ask for a regenerated
export. The widgets no longer show this mark; see [In the widgets](#in-the-widgets).

The mark is a blue chat bubble with an orange envelope: conversation becoming mail.

## SVG (masters)

| File | Use |
|---|---|
| `letterirl-mark.svg` | Default mark on light surfaces |
| `letterirl-mark-dark.svg` | Mark on dark surfaces (blues lightened; orange unchanged) |
| `letterirl-mark-mono.svg` | Single-color mark — stamps, print, anywhere color is unavailable |
| `letterirl-mark-small.svg` | **Small-size cut** — simplified for ~11-20px rendering. Parametric: reads `--li-blue` / `--li-orange` with hardcoded fallbacks, so one file serves both themes by overriding the variable |
| `letterirl-mark-small-dark.svg` | Small cut with dark-surface colors baked in (use when CSS variables aren't available) |
| `letterirl-square.svg` | Square composition — favicons, app-directory icon, anywhere a 1:1 slot is required (the mark itself is ~3:2 and should not be letterboxed) |
| `letterirl-lockup.svg` | Mark + wordmark — site nav, OG images, documents |

## PNG / ICO exports (`png/`)

- **Favicons**: `favicon-16/32/48.png`, `favicon.ico`, `apple-touch-180.png`
- **Mark**: `mark-128/256/512/1024.png` (transparent)
- **Square**: `square-192/512/1024.png` — `square-1024` is the OpenAI app-directory submission size
- **Social**: `og-1200x630.png` (lockup)
- **Widget header**: `widget-logo-light.png`, `widget-logo-dark.png`. These are the website's
  mark, built by `scripts/build-widget-logo.ts`, not design-tool exports.

## In the widgets

Since widget template v33 the six ChatGPT widgets show **the website's mark**, the logo in
the website's navbar and footer (`public/logo.jpg` in `letter-irl-website`), so the cards
match the site. It is a different drawing from the design-tool mark above.

- `website/logo.jpg` is a copy of that file, taken from the website's `main` branch at
  `bc81767` (the file itself last changed in `97fa271`). It is a JPEG on white.
- `scripts/build-widget-logo.ts` makes the white transparent and trims the mark. It writes
  `png/widget-logo-light.png` and `png/widget-logo-dark.png` at 4x the header size of
  22.5 by 14 CSS pixels. The dark one lifts the blues 34% toward white, as the old dark mark
  did, and leaves the orange alone.
- The script inlines both files as `data:` URIs in every widget's `.logo` and
  `.dark .logo` rules. Widgets must stay single-file, and the enforced CSP allows `data:`
  images (issue #228). The header markup is an empty `<span class="logo" aria-hidden="true">`.
- A test in `tests/unit/mcp/widgetResources.test.ts` checks that all six widgets carry
  exactly the two files.

**When the website's mark changes,** copy the new file over `website/logo.jpg`, run
`npx tsx scripts/build-widget-logo.ts`, bump `WIDGET_TEMPLATE_VERSION`, re-record the widget
digest, and refresh the connectors (see `docs/deployment.md`).
