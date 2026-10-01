/**
 * An account's remembered stationery (#563, migration 045): the theme it last
 * chose explicitly, in a letter preview's `stationery`, set_stationery or the
 * letter card's Style control. A letter preview that asks for none is drawn
 * in it. Only the theme: the initials and a headline belong to one letter.
 *
 * Read and written only while stationery is offered; the callers check.
 * set_stationery remembers in the transaction that restyles the draft
 * (draftService.setDraftStationery).
 */

import { query } from '../db/index.js';
import { STATIONERY_THEMES, type StationeryTheme } from '../render/stationery.js';

/** The account's remembered theme, or null for none. A theme this build does not draw (a later build's) is none. */
export async function rememberedStationery(userId: string): Promise<StationeryTheme | null> {
  const result = await query<{ stationery_theme: string | null }>(
    'SELECT stationery_theme FROM users WHERE user_id = $1',
    [userId]
  );
  const theme = result.rows[0]?.stationery_theme ?? null;
  return theme !== null && (STATIONERY_THEMES as readonly string[]).includes(theme) ? (theme as StationeryTheme) : null;
}

/** Remembers a theme the account chose, Classic included. */
export async function rememberStationery(userId: string, theme: StationeryTheme): Promise<void> {
  await query('UPDATE users SET stationery_theme = $2 WHERE user_id = $1', [userId, theme]);
}
