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

/** PostGrid's white frame sits 1/8in inside the edge; nothing is drawn within 1/4in. */
export const EDGE_CLEARANCE = inch(0.25);

export const SIDE_MARGIN = inch(1);
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * SIDE_MARGIN;

/** The body starts just below the address zone (the legacy HTML guessed 3.5in). */
export const BODY_TOP = inch(3);
/** The legacy HTML's 1in bottom margin. */
export const BODY_BOTTOM = PAGE_HEIGHT - inch(1);

export const BODY_FONT_SIZE = 12;
/** The legacy HTML's line-height of 1.6 at 12pt. */
export const LINE_PITCH = 19.2;

/** The legacy HTML's image boxes: full content width, capped heights, 0.5in gaps. */
export const HEADER_IMAGE_MAX_HEIGHT = inch(2);
export const INLINE_IMAGE_MAX_HEIGHT = inch(3);
export const IMAGE_GAP = inch(0.5);
