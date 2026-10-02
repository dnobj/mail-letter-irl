/**
 * Page geometry for printed letters, in PDF points (1/72 inch), measured from
 * the page's top-left corner.
 *
 * The address zone comes from the #534 Phase 0 probe (PostGrid test mode,
 * 2026-09-30, letter_x5ck6NgyKz8XtqkWuLrt5v). With addressPlacement
 * top_first_page, PostGrid fills two white boxes and stamps the addresses in
 * them: the return address at x 0.50-3.75in, y 0.20-1.50in, and the recipient
 * at x 0.50-3.75in, y 1.50-2.80in. It also strokes a white frame 1/8in inside
 * the page edge. Anything drawn there is covered, so the layout keeps a margin
 * around both.
 */

export const POINTS_PER_INCH = 72;
const inch = (inches: number): number => inches * POINTS_PER_INCH;

export const PAGE_WIDTH = inch(8.5);
export const PAGE_HEIGHT = inch(11);

/** Where PostGrid's white address boxes go, with a 0.1in margin on each side. */
export const ADDRESS_ZONE = { left: inch(0.4), top: inch(0.1), right: inch(3.85), bottom: inch(2.9) } as const;

/** Where and how PostGrid stamps the two addresses: each block from its first baseline down. */
export interface StampGeometry {
  x: number;
  returnBaseline: number;
  recipientBaseline: number;
  pitch: number;
  size: number;
}

/**
 * How PostGrid stamps the addresses into those boxes, decoded from probe P6
 * (letter_pypQkUM56Cc5s7vDRU6qe6): Open Sans at 9pt, in upper case, from x
 * 0.70in; the return address's first baseline at 0.438in and the recipient's
 * at 2.094in, each line 0.177in below the last. The PDF leaves the zone
 * empty; a preview draws the addresses here so the page shows what prints.
 */
export const ADDRESS_STAMP: StampGeometry = {
  x: inch(0.7),
  returnBaseline: inch(0.438),
  recipientBaseline: inch(2.094),
  pitch: inch(0.177),
  size: 9
};

/** PostGrid's white frame sits 1/8in inside the edge; nothing is drawn within 1/4in. */
export const EDGE_CLEARANCE = inch(0.25);

export const SIDE_MARGIN = inch(1);
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * SIDE_MARGIN;

/** The body starts just below the address zone (the legacy HTML guessed 3.5in). */
export const BODY_TOP = inch(3);
/** The legacy HTML's 1in bottom margin. */
export const BODY_BOTTOM = PAGE_HEIGHT - inch(1);

/**
 * Where the text starts on a letter's later pages (#586): 1in from the top,
 * as on the gift page. PostGrid stamps the addresses on the first page only.
 */
export const CONTINUATION_TOP = inch(1);
/** The longest letter printed (#586): three pages, two sheets printed on both sides. */
export const MAX_LETTER_PAGES = 3;

export const BODY_FONT_SIZE = 12;
/** The legacy HTML's line-height of 1.6 at 12pt. */
export const LINE_PITCH = 19.2;

/** The legacy HTML's image boxes: full content width, capped heights, 0.5in gaps. */
export const HEADER_IMAGE_MAX_HEIGHT = inch(2);
export const INLINE_IMAGE_MAX_HEIGHT = inch(3);
export const IMAGE_GAP = inch(0.5);

/**
 * A 9x6 postcard as PostGrid takes it from a PDF, from #534's probe P9
 * (test mode, 2026-10-01): two pages, front then back, each 9.25 x 6.25in,
 * a 0.125in bleed on every side. A 9 x 6in page is refused, and both pages
 * are flattened at 300 ppi. On the back PostGrid stamps the addresses in
 * Open Sans 9pt from x 5.725in (from the page's edge, bleed included), and it
 * cancels a postcard with anything drawn in their region. A back drawn only
 * in its left half, as the legacy back is, prints.
 */
export const POSTCARD_WIDTH = inch(9.25);
export const POSTCARD_HEIGHT = inch(6.25);
export const POSTCARD_BLEED = inch(0.125);

/** The back's message: the legacy back's left 4.5in, inside 0.4in of padding. */
export const POSTCARD_MESSAGE = {
  left: POSTCARD_BLEED + inch(0.4),
  top: POSTCARD_BLEED + inch(0.4),
  width: inch(4.5 - 2 * 0.4),
  height: inch(6 - 2 * 0.4)
} as const;
/** Where the back's left half ends: nothing is drawn to the right of it. */
export const POSTCARD_HALF = POSTCARD_BLEED + inch(4.5);

/**
 * How PostGrid stamps a postcard's back, decoded from probes P9 and P11 (from
 * the page's edge, bleed included): Open Sans 9pt in upper case from x
 * 5.725in, "RETURN TO:" then the return address from baseline 0.958in, and
 * the recipient from 4.937in, each line 0.177in below the last. Each block
 * keeps its first baseline whatever its number of lines.
 */
export const POSTCARD_STAMP: StampGeometry = {
  x: inch(5.725),
  returnBaseline: inch(0.958),
  recipientBaseline: inch(4.937),
  pitch: inch(0.177),
  size: 9
};

/** The legacy back's message: 14pt at a line-height of 1.6. */
export const POSTCARD_FONT_SIZE = 14;
export const POSTCARD_LINE_PITCH = 22.4;

/**
 * A gift postcard's strip (docs/gift-letters.md), at the foot of the
 * message, from the legacy CSS: a 1pt rule, 0.14in of padding, then the QR at
 * 0.95in, 0.18in from its words. Its height is fixed, so the message's room
 * (11 lines) never depends on the code or the dates the strip prints.
 */
export const POSTCARD_STRIP = {
  height: inch(1.75),
  rule: 1,
  padTop: inch(0.14),
  qr: inch(0.95),
  gap: inch(0.18)
} as const;

/**
 * A postcard's size as a draft names it (#594), as PostcardSize in
 * src/services/types.ts does: '6x9' is PostGrid's 9x6 and '6x11' its 11x6.
 */
export type PostcardSizeName = '6x4' | '6x9' | '6x11';

/** One postcard size as PostGrid takes it from a PDF, and as our back is drawn. */
export interface PostcardGeometry {
  /** The page, bleed included. */
  readonly width: number;
  readonly height: number;
  /** The back's message box. */
  readonly message: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  /** Where the back's drawing ends: PostGrid's address region lies beyond it. */
  readonly half: number;
  /** How PostGrid stamps the addresses, for a preview to draw them where they print. */
  readonly stamp: Readonly<StampGeometry>;
  /** The message's size and line pitch. */
  readonly fontSize: number;
  readonly linePitch: number;
}

/**
 * USPS's barcode clear zone (DMM 202.5.4): the lower right of a card's
 * address side, from 4.75in left of its right edge and 0.625in up from its
 * bottom, kept free for the barcode USPS may print there. PostGrid's test
 * mode prints no barcode, so probe P14 could not show it, and its check of
 * the address region let a back drawn into it print. Every back's message
 * stays out of it (#595 review round 1).
 */
export const BARCODE_CLEAR_ZONE = { width: inch(4.75), height: inch(0.625) } as const;

/**
 * Each postcard size (#594), from probes P9 and P11 (9x6) and P14 (6x4 and
 * 11x6, PostGrid test mode, 2026-10-02). Every size takes a 0.125in bleed:
 * 6.25 x 4.25in, 9.25 x 6.25in and 11.25 x 6.25in, and a page of the trim
 * size alone is refused. PostGrid stamps "RETURN TO:" from baseline 0.958in
 * and the recipient 1.313in above the bottom edge, from x 3.925in (6x4),
 * 5.725in (9x6) or 7.725in (11x6), and cancels a postcard with anything
 * drawn in its address region; a back drawn to 3.4in (6x4) or 6.5in (11x6)
 * of its trim still prints. The 6x9 back is the legacy back's, unchanged.
 * The 4x6 back takes its left 3.25in, at 12pt as a letter's body is, and
 * ends above the barcode clear zone, which it is too narrow to end left of
 * as the others do: 11 lines. The 11x6 back takes its left 6in, at the
 * 6x9's 14pt: 16 lines.
 */
export const POSTCARD_GEOMETRY: Readonly<Record<PostcardSizeName, PostcardGeometry>> = {
  '6x9': {
    width: POSTCARD_WIDTH,
    height: POSTCARD_HEIGHT,
    message: POSTCARD_MESSAGE,
    half: POSTCARD_HALF,
    stamp: POSTCARD_STAMP,
    fontSize: POSTCARD_FONT_SIZE,
    linePitch: POSTCARD_LINE_PITCH
  },
  '6x4': {
    width: inch(6.25),
    height: inch(4.25),
    message: {
      left: POSTCARD_BLEED + inch(0.3),
      top: POSTCARD_BLEED + inch(0.3),
      width: inch(3.25 - 2 * 0.3),
      height: inch(4 - 0.3) - BARCODE_CLEAR_ZONE.height
    },
    half: POSTCARD_BLEED + inch(3.25),
    stamp: { x: inch(3.925), returnBaseline: inch(0.958), recipientBaseline: inch(2.937), pitch: inch(0.177), size: 9 },
    fontSize: 12,
    linePitch: 19.2
  },
  '6x11': {
    width: inch(11.25),
    height: inch(6.25),
    message: { left: POSTCARD_BLEED + inch(0.4), top: POSTCARD_BLEED + inch(0.4), width: inch(6 - 2 * 0.4), height: inch(6 - 2 * 0.4) },
    half: POSTCARD_BLEED + inch(6),
    stamp: { x: inch(7.725), returnBaseline: inch(0.958), recipientBaseline: inch(4.937), pitch: inch(0.177), size: 9 },
    fontSize: POSTCARD_FONT_SIZE,
    linePitch: POSTCARD_LINE_PITCH
  }
};
