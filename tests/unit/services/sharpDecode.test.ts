import { describe, expect, it } from "vitest";
import sharp from "sharp";

/**
 * Real decode coverage for the sharp/libvips upgrade (0.34.5 -> 0.35.4,
 * D-01/A-04). imageService.test.ts mocks sharp, so nothing else in the suite
 * proves the actual decoder still works after the major bump; that gap is why
 * the CVE-carrying version sat here. These tests use no mock: they encode real
 * bytes and hand them back to sharp exactly as imageService does
 * (decode -> resize cover -> jpeg -> re-read metadata), across the three
 * formats a beta user can supply.
 */
async function solid(format: "png" | "jpeg" | "webp", w = 40, h = 30): Promise<Buffer> {
  const base = sharp({
    create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } },
  });
  if (format === "png") return base.png().toBuffer();
  if (format === "jpeg") return base.jpeg().toBuffer();
  return base.webp().toBuffer();
}

describe("sharp decodes customer-supplied image bytes", () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    it(`decodes ${format}, resizes cover and re-encodes to jpeg`, async () => {
      const source = await solid(format);
      // The imageService pipeline: sharp(buffer).resize(w,h,{cover}).jpeg().toBuffer()
      const processed = await sharp(source)
        .resize(24, 24, { fit: "cover", position: "center" })
        .jpeg({ quality: 82 })
        .toBuffer();
      const meta = await sharp(processed).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(24);
      expect(meta.height).toBe(24);
    });
  }

  it("reads width, height and format the way imageService does", async () => {
    const meta = await sharp(await solid("png", 100, 60)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(60);
  });

  it("rejects bytes that are not an image", async () => {
    await expect(sharp(Buffer.from("this is not an image")).metadata()).rejects.toThrow();
  });
});
