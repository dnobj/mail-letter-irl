# Letter IRL brand assets

Delivered by the design tool (Aug 23, 2026) as part of the widget design package.
**All variants are generated from the same source — never hand-recolor one.** If a
new size or color is needed, ask for a regenerated export.

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

## In the widgets

The five ChatGPT widgets inline `letterirl-mark-small.svg` directly in their header
(`<span class="logo">…</span>`) rather than referencing this folder: widgets must stay
single-file with no external assets, and a strict CSP is coming (issue #228). The dark
scope sets `--li-blue: #6f98f2` so the same inlined markup themes itself — this replaced
two base64 PNGs per widget (~4KB each) with one ~0.5KB vector.

**When the mark changes, re-inline it in all five `widgets/*.html`, bump
`WIDGET_TEMPLATE_VERSION`, and refresh the connector** — see `docs/deployment.md`.
