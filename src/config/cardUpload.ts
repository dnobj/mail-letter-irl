import type { ClientProfile } from '../auth/clientProfiles.js';
import { offUnlessExplicitlyEnabled, positiveIntegerSetting } from '../utils/envSettings.js';

/**
 * Photo upload from our card in an app with no file store (#474, phase 3).
 *
 * ChatGPT keeps a photo the upload card picks in its own file store and hands
 * us a download link. MCP Apps has no such store, so in Claude the card sends
 * the photo itself, in chunks, through the card-only tool upload_photo_chunk
 * (src/services/photoUploadService.ts). Off unless explicitly enabled while it
 * is proven on development: off, the tool is not listed and refuses a call.
 */
export function isCardUploadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_CARD_UPLOAD_ENABLED', env);
}

/**
 * Whether the upload card in this app sends the photo to Letter IRL itself:
 * where the app shows our cards and gives them no file store, which is every
 * such app but ChatGPT, and only while the switch is on. There the card
 * leaves no imageUrl to pass on, so the model's text says to call the preview
 * with no image (serverInstructions.ts, upload_image).
 */
export function uploadsThroughCard(client: ClientProfile, env: NodeJS.ProcessEnv = process.env): boolean {
  return client.rendersCards && client.name !== 'chatgpt' && isCardUploadEnabled(env);
}

/**
 * How many uploads one account may start in a rolling 24 hours. The card
 * shrinks a photo before sending it and an account holds one photo at a time,
 * so a person making a few postcards needs a handful; the cap is for a
 * script, not a person.
 */
export function dailyPhotoUploadsPerAccount(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting('LETTER_IRL_PHOTO_UPLOADS_PER_DAY', 20, 1, 1000, env);
}
