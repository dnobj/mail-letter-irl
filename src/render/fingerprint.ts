import { createHash } from 'node:crypto';
import type { Layout } from './layout.js';

/**
 * Held mail prints as previewed (#697, decision D3). A letter held for its
 * mail date waits up to the schedule's horizon before it prints, and a
 * renderer, a font or a layout rule changed in between could move its line
 * breaks. So the send records what the print would draw, as a fingerprint,
 * and the print draws it again and compares. A difference holds the letter
 * for an operator rather than printing something nobody saw.
 *
 * LAYOUT_ENGINE_VERSION names the layout engine whose output the golden
 * layouts record (tests/unit/render/layoutEngineVersion.test.ts): a change
 * to any golden layout must come with a new version, so a deploy that moves
 * line breaks says so in the letters it fingerprints from then on.
 */
export const LAYOUT_ENGINE_VERSION = 'layout-1';

/** The fingerprint's own scheme: how the layout below is reduced to a hash. */
export const LAYOUT_FINGERPRINT_SCHEME = 'fp1';

const FINGERPRINT_SHAPE = /^fp[1-9][0-9]{0,3}:[0-9a-f]{64}$/;

/** Whether a stored value is a fingerprint, of any scheme. */
export function isLayoutFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_SHAPE.test(value);
}

/** The scheme a stored fingerprint was made with: `fp1`, or another a later build writes. */
export function fingerprintScheme(fingerprint: string): string {
  return fingerprint.slice(0, fingerprint.indexOf(':'));
}

/**
 * A number to a thousandth of a point: what the page can show. Two builds
 * that compute the same position by different arithmetic agree here, where
 * their last bits may not.
 */
function rounded(value: number): number | string {
  if (!Number.isFinite(value)) return String(value);
  const fixed = Math.round(value * 1000) / 1000;
  return Object.is(fixed, -0) ? 0 : fixed;
}

/**
 * The layout as plain data, with every object's keys sorted and every number
 * rounded, and each image as its bytes' SHA-256 with its type and size: the
 * same layout reads the same however the code that made it orders its fields.
 */
function canonical(value: unknown): unknown {
  if (typeof value === 'number') return rounded(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { sha256: createHash('sha256').update(value).digest('hex') };
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const field = (value as Record<string, unknown>)[key];
      if (field !== undefined) sorted[key] = canonical(field);
    }
    return sorted;
  }
  return value;
}

/**
 * The fingerprint of what a print draws: the pages' items (text runs as
 * their font, size, position and drawn text; images by their bytes' hash;
 * boxes, rectangles and paths as they are), the page size, and the renderer
 * version the PDF names. Line breaks, page breaks and positions all change it;
 * the order of fields in the code does not.
 */
export function layoutFingerprint(layout: Layout, rendererVersion: string): string {
  const drawn = {
    rendererVersion,
    width: layout.width,
    height: layout.height,
    pages: layout.pages.map((page) => page.items)
  };
  const digest = createHash('sha256').update(JSON.stringify(canonical(drawn))).digest('hex');
  return `${LAYOUT_FINGERPRINT_SCHEME}:${digest}`;
}
