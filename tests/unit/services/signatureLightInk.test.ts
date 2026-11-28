/**
 * Light ink on a dark sheet (#611): the closing takes light strokes for paper,
 * so the dark sheet between their bends reads as ink. Such a picture is
 * refused as no signature found, while every picture the cleaner found a
 * signature in before still has one: cards on dark desks, a lit strip in a
 * shadow, a deep shadow over most of the sheet, pencil and grey ink. The cases
 * are #611's, from #609's review rounds 4 to 6. Synthetic pictures drawn with
 * sharp stand in for photographs, as in signatureImage.test.ts, whose own
 * regression set runs unchanged.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { cleanSignatureImage, SignatureImageError } from '../../../src/services/signatureImage.js';

/** The scribble of signatureImage.test.ts: x 120..900 and y 110..330 of a 1000 x 400 sheet. */
const STROKE =
  'M 120 260 C 180 120, 240 120, 260 240 S 330 330, 380 200 C 420 110, 470 140, 470 230 C 470 300, 540 300, 600 180 C 640 100, 690 170, 700 240 L 900 210';

const grey = (level: number) => {
  const hex = level.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
};

const photograph = (width: number, height: number, body: string, quality = 80) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`))
    .jpeg({ quality })
    .toBuffer();

const scribble = (transform: string, strokeWidth: number, ink: string) =>
  `<g transform="${transform}"><path d="${STROKE}" fill="none" stroke="${ink}" stroke-width="${strokeWidth}" stroke-linecap="round"/></g>`;

/** A grey noise laid over a sheet at this opacity, as a fibre or a slate's grain. */
const TEXTURE = (opacity: number) =>
  `<filter id="t"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="3"/>` +
  `<feColorMatrix type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 ${opacity} 0"/></filter>`;

/** What the cleaner says: the refusal's code, or 'found'. */
async function verdict(picture: Buffer): Promise<string> {
  try {
    await cleanSignatureImage(picture);
    return 'found';
  } catch (error) {
    if (error instanceof SignatureImageError) return error.code;
    throw error;
  }
}

describe('light ink on a dark sheet is refused as no signature found (#611)', () => {
  // #611's frames, and the two #609 round 6 swept besides (600 x 240 saved 5 of 12, 1200 x 300 all).
  const frames = [
    { width: 1000, height: 400, scale: 1 },
    { width: 3000, height: 1200, scale: 3 },
    { width: 600, height: 240, scale: 0.6 },
    { width: 1200, height: 300, scale: 1.2 }
  ];
  for (const frame of frames) {
    for (const sheet of [80, 90, 100, 110, 120, 130, 140]) {
      it(`white ink on a sheet at grey ${sheet}, ${frame.width} x ${frame.height}`, async () => {
        const verdicts: string[] = [];
        for (const stroke of [3, 7, 14, 24]) {
          const picture = await photograph(
            frame.width,
            frame.height,
            `<rect width="100%" height="100%" fill="${grey(sheet)}"/>` + scribble(`scale(${frame.scale},${frame.height / 400})`, stroke, grey(240))
          );
          verdicts.push(`${stroke}:${await verdict(picture)}`);
        }
        expect(verdicts).toEqual(['3:NO_SIGNATURE_FOUND', '7:NO_SIGNATURE_FOUND', '14:NO_SIGNATURE_FOUND', '24:NO_SIGNATURE_FOUND']);
      });
    }
  }

  it.each([30, 42, 48])('white strokes %i px wide, short of the closing\'s window', async stroke => {
    const picture = await photograph(1000, 400, `<rect width="100%" height="100%" fill="${grey(100)}"/>` + scribble('', stroke, grey(240)));
    expect(await verdict(picture)).toBe('NO_SIGNATURE_FOUND');
  });

  // A textured sheet (a slate, a card's fibre) and a JPEG at low quality: the sheet is not one flat grey.
  for (const texture of [0.15, 0.3, 0.5]) {
    it(`white ink on a textured sheet, texture ${texture}`, async () => {
      const picture = await photograph(
        1000,
        400,
        `<defs>${TEXTURE(texture)}</defs><rect width="100%" height="100%" fill="${grey(90)}"/><rect width="100%" height="100%" filter="url(#t)"/>` +
          scribble('', 7, grey(240))
      );
      expect(await verdict(picture)).toBe('NO_SIGNATURE_FOUND');
    });
  }
  it.each([20, 12])('white ink on a dark sheet, as a JPEG at quality %i', async quality => {
    const picture = await photograph(1000, 400, `<rect width="100%" height="100%" fill="${grey(100)}"/>` + scribble('', 7, grey(240)), quality);
    expect(await verdict(picture)).toBe('NO_SIGNATURE_FOUND');
  });

  it.each([
    [1000, 400],
    [3000, 1200]
  ])('a dark card on a white desk, signed with a white pen, %i x %i', async (width, height) => {
    const s = width / 1000;
    const picture = await photograph(
      width,
      height,
      `<rect width="100%" height="100%" fill="#ffffff"/><rect x="${80 * s}" y="${60 * s}" width="${860 * s}" height="${300 * s}" fill="${grey(100)}"/>` +
        scribble(`scale(${s})`, 7 * s, grey(240))
    );
    expect(await verdict(picture)).toBe('NO_SIGNATURE_FOUND');
  });
});

describe('a signature the cleaner found before #611 is still found', () => {
  // A small card in a large frame, on a dark desk, with ink from black to grey (#609 round 5 refused 90 and 120).
  for (const card of [
    { width: 250, height: 150, scale: 0.26 },
    { width: 200, height: 120, scale: 0.2 }
  ]) {
    for (const desk of [40, 74]) {
      for (const ink of [45, 90, 120]) {
        it(`a ${card.width} x ${card.height} card on a desk at grey ${desk}, ink at grey ${ink}`, async () => {
          const x = 800 - card.width / 2;
          const y = 600 - card.height / 2;
          const picture = await photograph(
            1600,
            1200,
            `<rect width="100%" height="100%" fill="${grey(desk)}"/><rect x="${x}" y="${y}" width="${card.width}" height="${card.height}" fill="#f2f0ea"/>` +
              scribble(`translate(${x - card.width * 0.02},${y + card.height * 0.1}) scale(${card.scale})`, 12, grey(ink))
          );
          expect(await verdict(picture)).toBe('found');
        });
      }
    }
  }

  // The signature in a lit strip, with 45% shadow either side (#609 round 5 refused ink at 120).
  for (const sides of ['above and below', 'left and right'] as const) {
    for (const ink of [45, 100, 120]) {
      it(`a lit strip holding the signature, shadow ${sides}, ink at grey ${ink}`, async () => {
        const shadow =
          sides === 'above and below'
            ? '<rect width="1000" height="90" fill="#000" fill-opacity="0.45"/><rect y="350" width="1000" height="50" fill="#000" fill-opacity="0.45"/>'
            : '<rect width="90" height="400" fill="#000" fill-opacity="0.45"/><rect x="930" width="70" height="400" fill="#000" fill-opacity="0.45"/>';
        const picture = await photograph(1000, 400, '<rect width="100%" height="100%" fill="#f4f2ec"/>' + scribble('', 7, grey(ink)) + shadow);
        expect(await verdict(picture)).toBe('found');
      });
    }
  }

  // A deep shadow (the paper to grey 60) over half or more of the sheet (#609 round 5: non-monotonic with pencil).
  for (const share of [0.5, 0.65, 0.8]) {
    for (const ink of [20, 50, 100]) {
      it(`a 70% shadow over ${share * 100}% of the sheet, ink at grey ${ink}`, async () => {
        const picture = await photograph(
          1000,
          400,
          '<rect width="100%" height="100%" fill="#f4f2ec"/>' + scribble('', 7, grey(ink)) +
            `<rect width="${1000 * share}" height="400" fill="#000" fill-opacity="0.7"/>`
        );
        expect(await verdict(picture)).toBe('found');
      });
    }
  }

  // Pencil at 45% to 60% of white, at both sizes.
  for (const frame of [
    { width: 1000, height: 400, scale: 1 },
    { width: 3000, height: 1200, scale: 3 }
  ]) {
    for (const share of [0.45, 0.5, 0.55, 0.6]) {
      it(`pencil at ${share * 100}% of white, ${frame.width} x ${frame.height}`, async () => {
        const picture = await photograph(
          frame.width,
          frame.height,
          '<rect width="100%" height="100%" fill="#ffffff"/>' + scribble(`scale(${frame.scale})`, 4 * frame.scale, grey(Math.round(255 * share)))
        );
        expect(await verdict(picture)).toBe('found');
      });
    }
  }

  it.each([
    ['blue', '#1b2a6b'],
    ['red', '#b0182a'],
    ['green', '#1e6b2a'],
    ['purple', '#5b2a8b']
  ])('a %s pen, in grey', async (_name, ink) => {
    const picture = await photograph(1000, 400, '<rect width="100%" height="100%" fill="#ffffff"/>' + scribble('', 7, ink));
    expect(await verdict(picture)).toBe('found');
  });

  it.each([40, 25, 12])('a JPEG at quality %i', async quality => {
    const picture = await photograph(1000, 400, '<rect width="100%" height="100%" fill="#f4f2ec"/>' + scribble('', 7, '#1b2a6b'), quality);
    expect(await verdict(picture)).toBe('found');
  });

  // Ink the grey of a shadow's paper, its stroke running into the shadow: the ink and the shadow match, but the
  // ink lies on paper, which fills most of its box with light.
  for (const [share, opacity, ink] of [[0.15, 0.6, 90], [0.15, 0.6, 100], [0.15, 0.7, 70], [0.25, 0.6, 100], [0.25, 0.7, 80], [0.35, 0.7, 90]] as const) {
    it(`ink at grey ${ink} running into a ${opacity * 100}% shadow over ${share * 100}% of the sheet`, async () => {
      const picture = await photograph(
        1000,
        400,
        '<rect width="100%" height="100%" fill="#f4f2ec"/>' + scribble('', 7, grey(ink)) +
          `<rect width="${1000 * share}" height="400" fill="#000" fill-opacity="${opacity}"/>`
      );
      expect(await verdict(picture)).toBe('found');
    });
  }

  // A shadow on the right over half the box, at the grey of the ink's mean: the ink is two greys, light and shaded
  // (#806 round 1 predicted ink at 100; 120 was the one refused).
  for (const ink of [60, 80, 100, 120]) {
    it(`ink at grey ${ink} under a 65% shadow over the right of the sheet`, async () => {
      const picture = await photograph(
        1000,
        400,
        '<rect width="100%" height="100%" fill="#f4f2ec"/>' + scribble('', 7, grey(ink)) +
          '<rect x="480" width="520" height="400" fill="#000" fill-opacity="0.65"/>'
      );
      expect(await verdict(picture)).toBe('found');
    });
  }

  // A strip of paper turned on a desk of the ink's grey: the desk's wedges are inside the box.
  for (const [desk, ink] of [[40, 40], [55, 55], [70, 70]]) {
    it(`a strip turned 25 degrees on a desk at grey ${desk}, ink at grey ${ink}`, async () => {
      const picture = await photograph(
        1200,
        900,
        `<rect width="100%" height="100%" fill="${grey(desk)}"/><g transform="rotate(25 600 450)"><rect x="300" y="375" width="600" height="150" fill="#f2f0ea"/>` +
          scribble('translate(290,395) scale(0.62)', 10, grey(ink)) + '</g>'
      );
      expect(await verdict(picture)).toBe('found');
    });
  }

  for (const texture of [0.15, 0.3, 0.5]) {
    it(`dark ink on textured paper, texture ${texture}`, async () => {
      const picture = await photograph(
        1000,
        400,
        `<defs>${TEXTURE(texture)}</defs><rect width="100%" height="100%" fill="#f4f2ec"/><rect width="100%" height="100%" filter="url(#t)"/>` +
          scribble('', 7, grey(60))
      );
      expect(await verdict(picture)).toBe('found');
    });
  }

  it.each([
    [40, 50],
    [60, 50],
    [60, 60]
  ])('a signature on a card that runs off it onto a desk at grey %i, ink at grey %i', async (desk, ink) => {
    const picture = await photograph(
      1600,
      1200,
      `<rect width="100%" height="100%" fill="${grey(desk)}"/><rect x="500" y="400" width="600" height="400" fill="#f2f0ea"/>` +
        scribble('translate(530,470) scale(0.66)', 10, grey(ink))
    );
    expect(await verdict(picture)).toBe('found');
  });

  it('pencil on a small card on a dark desk', async () => {
    const picture = await photograph(
      1600,
      1200,
      '<rect width="100%" height="100%" fill="#2e2e2e"/><rect x="675" y="525" width="250" height="150" fill="#f2f0ea"/>' +
        scribble('translate(670,540) scale(0.26)', 10, grey(Math.round(255 * 0.5)))
    );
    expect(await verdict(picture)).toBe('found');
  });
});
