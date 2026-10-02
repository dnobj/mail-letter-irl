# What PostGrid does with our own PDFs (issue #534)

**Date:** September 30, 2026; postcards October 1, 2026; letters of more than one page, and the 4x6 and 11x6 postcards, October 2, 2026 · **Probes:** PostGrid test mode, with development's key. The scripts are outside the repo, in `C:\letter-irl-scripts\probe-534\`: `probe-534.mjs`, `probe-586.mjs`, `decode-534.mjs`, `extract-raster.mjs`, `proof-pages.mjs` and `postcard-sizes-probe-build.mjs`.

## Why we probed

PostGrid prints every HTML letter in Open Sans, whatever font the HTML names (#526), so the serif preview and the paper differ. Issue #534 lays letters out ourselves. PostGrid's docs don't say what an uploaded PDF must satisfy, or whether its HTML renderer loads web fonts, so we sent probes and decoded what came back.

## Results

| Probe | Sent | Came back |
|-------|------|-----------|
| P1 | HTML whose CSS embeds Tinos as an `@font-face` data URI | Our font is used: the PDF embeds a Tinos subset as vector text, positioned as the CSS placed it |
| P2 | A pdfkit PDF (Tinos subset, a JPEG) by multipart, `addressPlacement: top_first_page`, `color: false` | Accepted, `pageCount` 1. **The page is flattened** into one 2550x3300 grayscale image (300 px per inch). No font of ours survives. The addresses are stamped on top as vector Open Sans, 9 pt |
| P4, P5 | PDFs from `src/render` | P4 printed Hebrew with each word's letters reversed. P5, with glyphs drawn as outlines, printed it correctly |
| P8 | A two-page PDF from `src/render`: a letter, then a funded gift card with its QR as vector rectangles (October 1, 2026) | Accepted, `pageCount` 2. Both pages flattened at 300 px per inch; the addresses stamped on page 1 only. The QR cropped from the flattened page 2 decodes with jsQR, and its border, type and modules are crisp |
| P13 | Two letters from `src/render` with `doubleSided: true` (October 2, 2026): two pages in Classic (`letter_ry68S6tZ8UwjUyP2a8T1yB`) and three in Handwritten (`letter_35HRt3npF2z9sszGzq18Z9`) | Accepted, `pageCount` 2 and 3: it counts sides, not sheets. See "Letters of more than one page" below |

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

**The stamp itself** (probe P6, decoded line by line):
- Open Sans Regular at 9 pt, every line in upper case, from x 0.70 in.
- Each line sits 0.177 in below the one before.
- The return address starts at 0.438 in and the recipient at 2.094 in, each as name, street lines, then "CITY, ST ZIP" with a comma after the city.
- Accents survive ("JOSÉ MUÑOZ ÑANDÚ", "DEPTO 4º").

A preview draws the addresses the same way (`ADDRESS_STAMP` in `geometry.ts`, `stampedAddressLines` in `previewService.ts`), so the page shows what prints. What was not probed:
- The addresses come from what we send, upper-cased by JavaScript's rules (ß becomes SS). Whether PostGrid standardises an address further before stamping it is not known.
- P6 had a three-line return address and a four-line recipient. Whether PostGrid moves the first baseline for other line counts is not known.
- The preview asks for Open Sans, which no card or confirm page loads, so viewers see a sans-serif fallback, slightly narrower than the print.

## Postcards

Probe P9 (October 1, 2026) sent PDF postcards at the only size the postcard tool offers, 6x9, which PostGrid calls `9x6`. They went to `/postcards` by multipart, with the contacts, `size` and `pdf` fields.

| Probe | Sent | Came back |
|-------|------|-----------|
| P9a | Two pages at 9.25 x 6.25 in (a 0.125 in bleed), a grid and rulers across the whole back | Accepted, then **cancelled** about six seconds later: `invalid_content`, "Content found overlapping address region." |
| P9b | The same at 9 x 6 in | Refused at once: `pdf_incorrect_size_error`, "File has incorrect page dimensions 9x6 when expecting 9.25x6.25." |
| P9c | 9.25 x 6.25 in, the back drawn only in its left half, as the legacy back is | Accepted and stayed `ready`, `pageCount` 2 |
| P10b | Our renderer's own postcard (`layoutPostcard`): a photo covering the front, 16 lines of the message in the back's left half | Accepted and stayed `ready`; the back flattened exactly as drawn |
| P11 | P10b's PDF, with a three-line recipient and a four-line return address | Each block kept its first baseline: "RETURN TO:" at 0.958 in with the four-line return address below it, the recipient at 4.937 in with three lines |

What they show:
- A postcard PDF carries its bleed: 0.125 in on every side.
- Both pages are flattened to 300 ppi images, the front in colour, and the front keeps its bleed.
- On the back, PostGrid stamps Open Sans 9 pt in upper case from x 5.725 in, measured from the page's edge with the bleed. "RETURN TO:" and the return address start at baseline 0.958 in, the recipient at 4.937 in, each line 0.177 in below the last.
- The test-mode render shows no postage and no barcode.
- PostGrid checks the back for content in its address region, after it accepts the postcard, and cancels the postcard if there is any. `src/render/postcard.ts` draws nothing right of the back's left half (`POSTCARD_HALF` in `geometry.ts`).

### The 4x6 and 11x6 postcards (#594)

Probe P14 (October 2, 2026) asked the same questions of PostGrid's two other postcard sizes, `6x4` and `11x6`, with eight postcards from `postcard-sizes-probe-build.mjs`:

| Probe | Sent | Came back |
|-------|------|-----------|
| P14b-6x4, P14b-11x6 | The trim size alone, 6 x 4 and 11 x 6 in | Refused at once: `pdf_incorrect_size_error`, "expecting 6.25x4.25" and "expecting 11.25x6.25" |
| P14a-6x4, P14a-11x6 | A 0.125 in bleed, a grid across the whole back | Accepted, then **cancelled**: `invalid_content`, "Content found overlapping address region." |
| P14c-6x4, P14c-11x6 | A 0.125 in bleed, the back drawn in its left half only, a three-line recipient and a four-line return address | Accepted and stayed `ready` |
| P14d-6x4, P14d-11x6 | The back drawn further right: to 3.4 in of the 6 in trim, and to 6.5 in of the 11 in | Accepted and stayed `ready` |

What they show, from the page's edge with the bleed:
- Every size takes a 0.125 in bleed: 6.25 x 4.25 in for `6x4`, 9.25 x 6.25 in for `9x6` and 11.25 x 6.25 in for `11x6`.
- PostGrid stamps Open Sans 9 pt in upper case, as at `9x6`, from x 3.925 in on a `6x4` and from x 7.725 in on an `11x6`. "RETURN TO:" is at baseline 0.958 in at every size, and the recipient is 1.313 in above the bottom edge: at 2.937 in on a `6x4`, and at 4.937 in on a `9x6` and an `11x6`.
- The address region starts somewhere right of 3.525 in on a `6x4` and right of 6.625 in on an `11x6`; the stamps start further right still. `POSTCARD_GEOMETRY` in `geometry.ts` ends the back at 3.375 in and 6.125 in.

What they cannot show: the test-mode render prints no postage and no barcode. USPS keeps a barcode clear zone on a card's address side (DMM 202.5.4), the trim's lower right 4.75 x 0.625 in, for the barcode its equipment may print. PostGrid's check of the address region let P14d's back, drawn into that band, print, so nothing in PostGrid's answers protects it. Every back's message stays out of it (`BARCODE_CLEAR_ZONE`, #595 review round 1):
- a `9x6` and an `11x6` end left of it: their messages end at 4.1 in and 5.6 in of the trim, where the zone starts at 4.25 in and 6.25 in;
- a `6x4` is too narrow for that, since its zone starts 1.25 in across. So its message ends 0.625 in above the trim's bottom edge, and the back holds 11 lines of 12 pt, not 12.

## Stationery (#563)

Probe P12 (October 1, 2026, `letter_k7rHRrWmsn28GJy64cSLHt`) asked two questions before any theme was offered. It was one letter page from a pdfkit script (`stationery-probe-build.mjs`), sent with `color: false` and the address zone left empty.

| Part | Drawn | Came back |
|------|-------|-----------|
| The corner | A dashed outline of 4.0-8.0 in across and 0.35-2.85 in down, a 12 pt date line, and initials in a 0.75 pt ring | Whole. PostGrid's stamp, white boxes and frame touch none of it |
| Sprigs | Line drawings stroked at 0.5, 0.75 and 1 pt in black, and at 0.75 pt in #555, #888 and #aaa | Every one crisp, every grey distinct |
| Confetti | Small filled shapes in #000, #444, #777 and #aaa | All four greys distinct |
| Rules | Lines across the body at 0.25 pt (#bbb, #ccc, #ddd, #e6e6e6) and 0.5 pt (#ccc, #ddd, #e6e6e6) | All visible. 0.5 pt rules keep their exact grey over two pixel rows. 0.25 pt rules come back lighter, spread over two rows: #bbb as 219, #e6e6e6 as 241 |
| Tints | Squares of 5%, 10%, 15%, 20%, 30% and 50% grey | Exactly the drawn values: 242, 230, 217, 204, 179, 128 |

The probe stayed `ready`, with nothing cancelled. The flattened page came back 2550 x 3300 at 300 px per inch.

What it means for themes (`src/render/stationery.ts`):
- **The corner beside the envelope window is free.** Themes draw their date line, monogram, sprigs and confetti in it (`STATIONERY_CORNER`).
- **Draw lines at 0.5 pt or more,** and in greys from #222 to #aaa. A 0.25 pt rule prints lighter than drawn.
- **Greys print as drawn in the PDF.** Whether a 5% tint shows on paper is a question for the live print, which test mode doesn't show.

## Letters of more than one page (#586)

Probe P13 (October 2, 2026) sent two letters from `src/render` by multipart with `doubleSided: true` (`probe-586.mjs` beside `probe-534.mjs`). One was two pages in Classic, the other three in Handwritten.
- **Accepted.** `pageCount` was 2 and 3: it counts sides, so nothing should read it as sheets.
- **The proofs keep our pages.** Two stay two and three stay three, with no blank back added for sheet 2.
- **Addresses on page 1 only,** as for one page. Pages 2 and 3 carry nothing of PostGrid's.
- **The bottom inch is clear on every page** of the proof. Our body ends 1 in from the bottom on every page.
- **Later pages print as drawn,** from 1 in (`CONTINUATION_TOP`), with Handwritten's rules on each.
- **Handwritten's PDFs are large.** Its glyph outlines come to about 217, 864 and 1,622 KB for one, two and three pages. The other themes are about 12, 35 and 60 KB.

Open, for a live double-sided print (the owner's call, since it costs a letter):
- which way the back flips;
- any marks PostGrid prints on the backs;
- whether page 2, printed on the back of the address area, shows through the envelope window. If it does, later pages start at 3 in (26 + 26 + 33 lines) before anything reaches production.

## What it means

- **Path P (our own PDF).** Whatever we draw prints, whatever fonts PostGrid has. The Open Sans allow-list (`src/services/printableText.ts`) still governs the addresses, which PostGrid stamps. The cost is that the print is a 300 px per inch grayscale image, not vector text. Path H, HTML with embedded fonts, also works (P1), but PostGrid decides its line breaks.
- **Draw glyph outlines, not text.** pdfkit shapes text word by word, and fontkit guesses each word's direction from its script, so a Hebrew word that was already put in visual order gets reversed again (P4). `src/render/glyphs.ts` shapes each line once, left to right, and the PDF and the SVG preview both draw the same outlines at the same positions. The page is flattened anyway, so outlines print exactly as text would.
- **Curves as exact cubics.** TrueType outlines are quadratic, and pdfkit draws an SVG `Q` with the PDF `v` operator, which is a different curve (up to 0.16 pt off on round letters). `glyphs.ts` writes each quadratic as the exact cubic, so the PDF and the SVG draw identical curves.
- **Bidi before drawing.** `src/render/bidi.ts` reorders each line by grapheme cluster, so a Hebrew point stays after its letter. bidi-js's `getMirroredCharactersMap` needs the `levels` array: given the result object, it mirrors nothing.

## Open

- Whether live mode flattens the same way. The owner's live print (#534 Acceptance) will show it.
- Colour letters (`color: true`) were not probed.
- Where PostGrid prints postage and the barcode on a live `6x4` and `11x6`. Their backs keep out of USPS's barcode clear zone either way; a live print of each size would show whether anything else lands near the message.
