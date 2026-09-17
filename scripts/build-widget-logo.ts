/**
 * Builds the widget header logo from the website's mark and inlines it into
 * every widget.
 *
 *   npx tsx scripts/build-widget-logo.ts [path/to/logo.jpg]
 *
 * The source defaults to assets/brand/website/logo.jpg, a copy of the
 * website's public/logo.jpg (the mark in its navbar and footer). That file is
 * a JPEG on white, so this script makes the white transparent:
 *
 * - A pixel far enough from white is solid and keeps its own color.
 * - Every other pixel takes the color of its nearest solid pixel. Its alpha is
 *   how far it sits from white toward that color, so edges keep no white
 *   fringe on a dark card.
 *
 * The dark variant lifts the blues 34% toward white, as the old dark mark did
 * (#2563eb to #6f98f2), and leaves the orange alone.
 *
 * Output: assets/brand/png/widget-logo-light.png and widget-logo-dark.png at
 * 4x the CSS size, and the header rules in widgets/*.html. After running it,
 * bump WIDGET_TEMPLATE_VERSION and re-record the widget digest.
 */

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "assets/brand/website/logo.jpg");
const OUT_DIR = path.join(ROOT, "assets/brand/png");
const WIDGET_DIR = path.join(ROOT, "widgets");

const CSS_HEIGHT = 14;
const SCALE = 4;
// How far from white (255 minus the smallest channel) a pixel must be to count
// as solid. The site's orange sits near 170 and its blues above 170.
const SOLID_INK = 150;
// JPEG noise on the white background.
const NOISE_INK = 6;
const TRIM_ALPHA = 0.03;
const TRIM_PAD = 2;
const DARK_BLUE_LIFT = 0.34;

interface Transparent {
  width: number;
  height: number;
  color: Float64Array; // rgb per pixel
  alpha: Float64Array;
}

async function makeTransparent(file: string): Promise<Transparent> {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const count = width * height;
  const ink = new Float64Array(count);
  const nearest = new Int32Array(count).fill(-1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < count; i++) {
    ink[i] = 255 - Math.min(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
    if (ink[i] >= SOLID_INK) {
      nearest[i] = i;
      queue[tail++] = i;
    }
  }
  if (tail === 0) throw new Error(`${file} has no solid pixels`);

  // Breadth-first from every solid pixel: each pixel learns its nearest one.
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (nearest[j] >= 0) continue;
        nearest[j] = nearest[i];
        queue[tail++] = j;
      }
    }
  }

  const color = new Float64Array(count * 3);
  const alpha = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const s = nearest[i];
    let dot = 0;
    let norm = 0;
    for (let c = 0; c < 3; c++) {
      const pixelInk = 255 - data[i * 3 + c];
      const refInk = 255 - data[s * 3 + c];
      dot += pixelInk * refInk;
      norm += refInk * refInk;
      color[i * 3 + c] = data[s * 3 + c];
    }
    if (s === i) alpha[i] = 1;
    else if (ink[i] < NOISE_INK) alpha[i] = 0;
    else alpha[i] = Math.min(1, Math.max(0, dot / norm));
  }
  return { width, height, color, alpha };
}

function trimBox(image: Transparent) {
  let x0 = image.width;
  let y0 = image.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.alpha[y * image.width + x] <= TRIM_ALPHA) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return {
    left: Math.max(0, x0 - TRIM_PAD),
    top: Math.max(0, y0 - TRIM_PAD),
    right: Math.min(image.width, x1 + 1 + TRIM_PAD),
    bottom: Math.min(image.height, y1 + 1 + TRIM_PAD),
  };
}

function liftBlues(color: Float64Array): Float64Array {
  const out = Float64Array.from(color);
  for (let i = 0; i < out.length; i += 3) {
    if (color[i + 2] <= color[i]) continue;
    for (let c = 0; c < 3; c++) out[i + c] = color[i + c] + (255 - color[i + c]) * DARK_BLUE_LIFT;
  }
  return out;
}

async function renderPng(image: Transparent, color: Float64Array): Promise<Buffer> {
  const box = trimBox(image);
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y + box.top) * image.width + (x + box.left);
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(color[i * 3 + c]);
      rgba[o + 3] = Math.round(image.alpha[i] * 255);
    }
  }
  // sharp premultiplies alpha around the resize, so edges do not darken. An
  // 8-bit palette at quality 60 keeps each file near 2 KB, and at 22.5 by 14
  // CSS pixels it looks the same as a full-color file.
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize({ height: CSS_HEIGHT * SCALE, kernel: "lanczos3" })
    .png({ palette: true, quality: 60, dither: 0, compressionLevel: 9, effort: 10 })
    .toBuffer();
}

function dataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function main() {
  const source = path.resolve(process.argv[2] ?? SOURCE);
  const image = await makeTransparent(source);
  const light = await renderPng(image, image.color);
  const dark = await renderPng(image, liftBlues(image.color));
  const { width, height } = await sharp(light).metadata();
  if (!width || !height) throw new Error("could not read the rendered logo size");

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "widget-logo-light.png"), light);
  await fs.writeFile(path.join(OUT_DIR, "widget-logo-dark.png"), dark);

  const logoRule =
    `.logo{width:${width / SCALE}px;height:${height / SCALE}px;flex:none;display:block;` +
    `background:url("${dataUri(light)}") center/contain no-repeat}`;
  const darkRule = `.dark .logo{background-image:url("${dataUri(dark)}")}`;

  const files = (await fs.readdir(WIDGET_DIR)).filter((name) => name.endsWith(".html"));
  for (const name of files) {
    const file = path.join(WIDGET_DIR, name);
    const html = await fs.readFile(file, "utf-8");
    if (!/^[ \t]*\.logo\{[^\n]*\}\r?$/m.test(html)) throw new Error(`${name} has no .logo rule`);
    const next = html
      .replace(/^[ \t]*\.dark \.logo\{[^\n]*\}\r?\n/m, "")
      .replace(/^([ \t]*)\.logo\{[^\n]*\}(\r?)$/m, (_match, indent: string, cr: string) =>
        `${indent}${logoRule}${cr}\n${indent}${darkRule}${cr}`
      )
      .replace(/<span class="logo"[^>]*>[\s\S]*?<\/span>/, '<span class="logo" aria-hidden="true"></span>');
    if (next !== html) await fs.writeFile(file, next);
    console.log(`${name}: ${next === html ? "unchanged" : "updated"}`);
  }
  console.log(`logo ${width}x${height} (${width / SCALE}x${height / SCALE} CSS px), light ${light.length} B, dark ${dark.length} B`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
