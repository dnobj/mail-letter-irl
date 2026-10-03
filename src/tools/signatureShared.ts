import { isSignaturesOffered } from '../config/signatures.js';
import { isUnresolvedImageReference, usableImageFile } from '../utils/imageFileParam.js';

/**
 * What the signature tools share (#608, concept 3): their refusals, where a
 * picture comes from, and how the saved signature reaches a card.
 */

export type SignatureRefusalCode =
  | 'SIGNATURES_OFF'
  | 'SIGNATURE_PICTURE_REQUIRED'
  | 'SIGNATURE_PICTURE_UNREADABLE'
  | 'NO_SIGNATURE_FOUND'
  | 'NOT_A_SIGNATURE'
  | 'SIGNATURE_TOO_SMALL'
  | 'CONFIRM_REQUIRED'
  | 'SIGNATURE_NOT_SAVED';

/**
 * Refusals the model can act on. The code doubles as the log's class, and no
 * refusal repeats a link or a picture.
 */
export class SignatureRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(readonly code: SignatureRefusalCode, message: string) {
    super(message);
    this.name = 'SignatureRefusedError';
    this.diagnosticClass = code;
  }
}

/**
 * The tools are listed only while signatures are offered (src/server.ts), and
 * refuse while they are not: a tool list cached while they were offered still
 * reaches them.
 */
export function requireSignatures(): void {
  if (!isSignaturesOffered()) {
    throw new SignatureRefusedError('SIGNATURES_OFF', "Signatures aren't available here.");
  }
}

/**
 * Where set_signature's picture comes from: a file ChatGPT resolved, then a
 * link. Null when the call named neither. A file the server cannot open is
 * refused as such, so the person is asked for a link or the file again,
 * rather than told no picture was given.
 */
export function signatureSourceOf(input: { image?: unknown; imageUrl?: string }): string | null {
  const file = usableImageFile(input.image);
  if (file) return file.download_url;
  const link = typeof input.imageUrl === 'string' ? input.imageUrl.trim() : '';
  if (link) return link;
  if (isUnresolvedImageReference(input.image)) {
    throw new SignatureRefusedError(
      'SIGNATURE_PICTURE_UNREADABLE',
      "That picture didn't come through. Ask the person to attach it again, or to share a link to it as imageUrl."
    );
  }
  return null;
}

/** The cleaned signature for a card to show: in _meta, never the model's (partitionToolResult). */
export function signatureImageUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}
