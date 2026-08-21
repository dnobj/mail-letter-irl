/**
 * Revision counter for the generate_image_fallback steering copy (issue #227).
 *
 * Bump this whenever the fallback tool's description or the image-routing
 * server instructions change. The value is appended to the served tool
 * description ("[copy rN]"), logged with every tools/list response, and
 * surfaced in the GenerateImageCard footer - so a client whose cached tool
 * list predates a copy change is identifiable from logs and screenshots
 * instead of guesswork (the native mobile apps cache tool metadata
 * aggressively; see issue #235).
 *
 * r1: FALLBACK ONLY description (PR #236)
 * r2: prohibition-first + image_gen named + chip-selection clause (PR #237)
 * r3: @-mention alone does not count as an explicit ask (this revision)
 */
export const STEERING_COPY_REV = 3;
