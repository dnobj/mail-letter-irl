export type ImageMime = 'image/jpeg' | 'image/png';

export interface RenderImage {
  bytes: Buffer;
  mime: ImageMime;
  /** Intrinsic size in pixels. */
  width: number;
  height: number;
}

/** JPEG start-of-frame markers that carry the image size (not DHT, JPG or DAC). */
const START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Reads a JPEG's or PNG's pixel size from its header, or throws. */
export function readImage(bytes: Buffer): RenderImage {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { bytes, mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset += 1; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (START_OF_FRAME.has(marker)) {
        return { bytes, mime: 'image/jpeg', height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  throw new Error('The image is neither a JPEG nor a PNG with a readable size.');
}

/** Decodes a `data:image/jpeg;base64,...` or PNG data URI, the form previews and letters store. */
export function readImageDataUri(dataUri: string): RenderImage {
  const match = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUri);
  if (!match) throw new Error('The image is not a JPEG or PNG data URI.');
  return readImage(Buffer.from(match[2], 'base64'));
}
