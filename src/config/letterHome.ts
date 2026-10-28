import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

export function isLetterHomeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_HOME_ENABLED', env);
}
