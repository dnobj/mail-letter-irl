# What PostGrid does with our own PDFs (issue #534)

**Date:** September 30, 2026 · **Probes:** PostGrid test mode, with development's key. The scripts are outside the repo, in `C:\letter-irl-scripts\probe-534\`: `probe-534.mjs`, `decode-534.mjs` and `extract-raster.mjs`.

## Why we probed

PostGrid prints every HTML letter in Open Sans, whatever font the HTML names (#526), so the serif preview and the paper differ. Issue #534 lays letters out ourselves. PostGrid's docs don't say what an uploaded PDF must satisfy, or whether its HTML renderer loads web fonts, so we sent probes and decoded what came back.

## Results

| Probe | Sent | Came back |
|-------|------|-----------|
| P1 | HTML whose CSS embeds Tinos as an `@font-face` data URI | Our font is used: the PDF embeds a Tinos subset as vector text, positioned as the CSS placed it |
| P2 | A pdfkit PDF (Tinos subset, a JPEG) by multipart, `addressPlacement: top_first_page`, `color: false` | Accepted, `pageCount` 1. **The page is flattened** into one 2550x3300 grayscale image (300 px per inch). No font of ours survives. The addresses are stamped on top as vector Open Sans, 9 pt |
| P4, P5 | PDFs from `src/render` | P4 printed Hebrew with each word's letters reversed. P5, with glyphs drawn as outlines, printed it correctly |

Multipart needs no contact objects: `to[firstName]`, `to[addressLine1]` and the other fields work as form fields beside the `pdf` file. They are read as UTF-8. Probe P6 (`letter_pypQkUM56Cc5s7vDRU6qe6`) sent "José Muñoz Ñandú" and "Zoë Brontë":
- PostGrid stored the names intact;
- it upper-cased the address lines, as on the JSON path;
- it stamped "JOSÉ MUÑOZ ÑANDÚ" in Open Sans.

**A reused `Idempotency-Key` replays the first letter, whatever the body** (probe P7, test mode). Three requests under one key, sent seconds apart by one script, all returned HTTP 201 with the first letter's id and description:
- a first PDF;
- a different PDF;
- then an HTML body.

So a retry whose body differs, as every multipart body does (a random boundary, the PDF's creation date), neither creates a second letter nor draws a rejection, at least within seconds. How long PostGrid keeps a key is neither documented nor probed.

## The address zone

PostGrid fills two white boxes and stamps the addresses in them. The positions are from the top-left of the page:

| Box | Across | Down | Text |
|-----|--------|------|------|
| Return address | 0.50-3.75 in | 0.20-1.50 in | Baselines 0.44, 0.62 and 0.79 in, from x 0.70 in |
| Recipient | 0.50-3.75 in | 1.50-2.80 in | Baselines 2.09-2.63 in, from x 0.70 in |

It also strokes a white frame 1/8 in inside the page edge. `src/render/geometry.ts` keeps x 0.40-3.85 in and y 0.10-2.90 in clear, and stays 0.25 in from every edge. The body starts at 3.0 in; the legacy HTML guessed 3.5 in.

## What it means

- **Path P (our own PDF).** Whatever we draw prints, whatever fonts PostGrid has. The Open Sans allow-list (`src/services/printableText.ts`) still governs the addresses, which PostGrid stamps. The cost is that the print is a 300 px per inch grayscale image, not vector text. Path H, HTML with embedded fonts, also works (P1), but PostGrid decides its line breaks.
- **Draw glyph outlines, not text.** pdfkit shapes text word by word, and fontkit guesses each word's direction from its script, so a Hebrew word that was already put in visual order gets reversed again (P4). `src/render/glyphs.ts` shapes each line once, left to right, and the PDF and the SVG preview both draw the same outlines at the same positions. The page is flattened anyway, so outlines print exactly as text would.
- **Curves as exact cubics.** TrueType outlines are quadratic, and pdfkit draws an SVG `Q` with the PDF `v` operator, which is a different curve (up to 0.16 pt off on round letters). `glyphs.ts` writes each quadratic as the exact cubic, so the PDF and the SVG draw identical curves.
- **Bidi before drawing.** `src/render/bidi.ts` reorders each line by grapheme cluster, so a Hebrew point stays after its letter. bidi-js's `getMirroredCharactersMap` needs the `levels` array: given the result object, it mirrors nothing.

## Open

- Whether live mode flattens the same way. The owner's live print (#534 Acceptance) will show it.
- Colour letters (`color: true`) were not probed.
