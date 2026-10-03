/**
 * The `image` argument of the three image preview tools, before and after the
 * served schema's preprocess step (#414).
 *
 * ChatGPT normally swaps a picture in the conversation for a file object,
 * `{download_url, file_id}`, before it calls the server. Some calls still
 * carry a string: the empty string mobile sends when nothing is attached, a
 * mobile placeholder such as "chat_upload://image_0", or the sandbox path the
 * model writes ("/mnt/data/photo.png") when the swap did not happen. The empty
 * string means no picture. Any other string names a specific picture that
 * the server cannot open, so the preprocess turns it into a marker file object
 * instead of dropping it. The marker still satisfies the served object schema,
 * so the JSON schema ChatGPT reads does not change.
 *
 * Pure on purpose: both schema layers import it, and neither may pull in the
 * database.
 */

import type { ImageFileParam } from "../services/types.js";

/** The file id of the marker that stands for an image reference the host did not resolve. */
export const UNRESOLVED_IMAGE_FILE_ID = "letter-irl:unresolved-image-reference";

/** The served schema's preprocess for `image`. */
export function preprocessImageFileParam(value: unknown): unknown {
  if (value === "") return undefined;
  if (typeof value === "string") return { download_url: "", file_id: UNRESOLVED_IMAGE_FILE_ID };
  return value;
}

/**
 * The preprocess for one photo of a collage's `images` (#616). A string where
 * the host did not swap in a file, blank or not, is a photo the server cannot
 * open: it becomes the marker, so the refusal names its place. (The single
 * `image` reads "" as no picture; in a list an empty slot is still a slot.)
 */
export function preprocessImageFileElement(value: unknown): unknown {
  if (typeof value === "string") return { download_url: "", file_id: UNRESOLVED_IMAGE_FILE_ID };
  return value;
}

/**
 * The preprocess for a collage's whole list, `images` or `imageUrls` (#616).
 * The blank string a host sends for an argument left unset is no list, as the
 * empty string is no `image`: without this the call fails the served schema,
 * and a single-photo postcard with it (ChatGPT mobile sends "" for a file
 * parameter with nothing attached). Any other string still fails the schema.
 */
export function preprocessPhotoList(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

/** A file object the server can download, or null. */
export function usableImageFile(image: unknown): ImageFileParam | null {
  if (!image || typeof image !== "object") return null;
  const downloadUrl = (image as { download_url?: unknown }).download_url;
  return typeof downloadUrl === "string" && downloadUrl ? (image as ImageFileParam) : null;
}

/**
 * True when an image was named but cannot be read: the marker above, any
 * other file object without a download address, or a string other than ""
 * that did not go through the preprocess (a caller that skips the schema must
 * not regain the older-upload fallback).
 */
export function isUnresolvedImageReference(image: unknown): boolean {
  if (typeof image === "string") return image !== "";
  return typeof image === "object" && image !== null && usableImageFile(image) === null;
}
