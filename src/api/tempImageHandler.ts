/**
 * Temporary Image Handler
 *
 * Serves generated images from the private temporary image store.
 * Images were stored by the removed generate_image_fallback tool and served here; the endpoint remains for any unexpired tokens and possible future writers (see docs/learnings/generate-image-removal-decision.md)
 * so the preview tools can download them via imageUrl.
 *
 * Route: GET /api/temp-image/:token
 * No authentication required — the random token acts as a capability URL.
 */

import http from "node:http";
import { getImage } from "../services/tempImageStore.js";

/**
 * Handle requests to /api/temp-image/:token
 * Returns true if the request was handled, false otherwise.
 */
export async function handleTempImageRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): Promise<boolean> {
  const match = pathname.match(/^\/api\/temp-image\/([a-f0-9]{32})$/);
  if (!match || req.method !== "GET") {
    return false;
  }

  const token = match[1];
  const base64Data = await getImage(token);

  if (!base64Data) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Image not found or expired" }));
    return true;
  }

  const buffer = Buffer.from(base64Data, "base64");

  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": buffer.length,
    "Cache-Control": "private, max-age=900" // 15 min
  });
  res.end(buffer);
  return true;
}
