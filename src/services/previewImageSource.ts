/**
 * Where an image preview tool gets its picture (#414).
 *
 * In order: a file object ChatGPT resolved, then `imageUrl`, then the user's
 * most recent upload through the upload card (recent_uploads), because
 * ChatGPT sometimes drops `imageUrl` on the call that follows an upload.
 *
 * A request that named a picture the server cannot open (see
 * utils/imageFileParam.ts) is treated more carefully. An older upload may
 * well be a different picture, so such a request uses an upload only when it
 * is recent enough to be the upload card's answer to this very failure: the
 * card records the upload and prompts the model at once.
 */

import { isUnresolvedImageReference, usableImageFile } from "../utils/imageFileParam.js";
import { getRecentUploadedImage } from "./recentUploadStore.js";
import type { ImageFileParam } from "./types.js";

/** How recent an upload must be to stand in for a picture the request named but the server cannot open. */
export const UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS = 10 * 60 * 1000;

export type PreviewImageSource =
  | { kind: "file"; url: string; file: ImageFileParam }
  | { kind: "url"; url: string }
  | { kind: "recent_upload"; url: string; ageMs: number; unresolvedReference: boolean }
  | { kind: "none"; unresolvedReference: boolean; skippedUploadAgeMs?: number };

export async function resolvePreviewImageSource(
  input: { image?: unknown; imageUrl?: string },
  userId: string,
  uploadContext: "postcard" | "header_image" | "inline_image"
): Promise<PreviewImageSource> {
  const file = usableImageFile(input.image);
  if (file) return { kind: "file", url: file.download_url, file };
  if (input.imageUrl) return { kind: "url", url: input.imageUrl };

  const unresolvedReference = isUnresolvedImageReference(input.image);
  const recent = await getRecentUploadedImage(userId, uploadContext);
  if (!recent?.imageUrl) return { kind: "none", unresolvedReference };
  if (unresolvedReference && recent.ageMs > UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS) {
    return { kind: "none", unresolvedReference, skippedUploadAgeMs: recent.ageMs };
  }
  return { kind: "recent_upload", url: recent.imageUrl, ageMs: recent.ageMs, unresolvedReference };
}
