/**
 * Every LETTER_IRL_* name the code reads is in the deployment manifest, or listed here with the reason it is not
 * (#682). The manifest is what the cutover preflight diffs against each Railway environment, so a flag missing from
 * it is a flag nobody sees is unset (LETTER_IRL_HOME_ENABLED and LETTER_IRL_CUSTOM_STATIONERY_ENABLED were).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_VAR_MANIFEST } from '../../../src/config/deploymentConfig.js';

/** Read by the code but knowingly left out of the manifest: each has a working default, or is not a deploy setting. */
const NOT_IN_MANIFEST: Record<string, string> = {
  // Routes and paths, each with its default, which every environment uses.
  LETTER_IRL_AUTH_SERVER_ROUTE: 'route with a default',
  LETTER_IRL_HEALTH_PATH: 'route with a default',
  LETTER_IRL_MANIFEST_ROUTE: 'route with a default',
  LETTER_IRL_MCP_PATH: 'route with a default',
  LETTER_IRL_OPENID_ROUTE: 'route with a default',
  LETTER_IRL_PROTECTED_RESOURCE_ROUTE: 'route with a default',
  LETTER_IRL_SSE_MESSAGES_PATH: 'route with a default',
  LETTER_IRL_SSE_PATH: 'route with a default',
  LETTER_IRL_WIDGET_DIR: 'path with a default',
  LETTER_IRL_WIDGET_PATH: 'route with a default',
  LETTER_IRL_HTTP_HOST: 'listener with a default',
  LETTER_IRL_HTTP_PORT: 'listener with a default (Railway sets PORT)',
  // Tuning with a safe default.
  LETTER_IRL_JSON_BODY_LIMIT_BYTES: 'limit with a default',
  LETTER_IRL_MCP_BODY_LIMIT_BYTES: 'limit with a default',
  LETTER_IRL_SIGNATURE_BODY_LIMIT_BYTES: 'limit with a default',
  LETTER_IRL_WEBHOOK_BODY_LIMIT_BYTES: 'limit with a default',
  LETTER_IRL_RECENT_UPLOAD_TTL_MS: 'lifetime with a default',
  LETTER_IRL_IMAGE_DAILY_CEILING: 'limit with a default',
  LETTER_IRL_IMAGE_STARTER_CREDITS: 'allowance with a default',
  LETTER_IRL_GIFT_CODE_TTL_DAYS: 'lifetime with a default',
  LETTER_IRL_GIFT_LETTER_TTL_DAYS: 'lifetime with a default',
  LETTER_IRL_GIFT_OPERATOR_GENERATIONS: 'limit with a default',
  LETTER_IRL_GIFT_QR_FORMAT: 'format with a default',
  LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS: 'with a default',
  LETTER_IRL_OAUTH_SCOPES: 'with a default',
  LETTER_IRL_OAUTH_EMAIL_CLAIM: 'with a default',
  LETTER_IRL_OAUTH_EMAIL_VERIFIED_CLAIM: 'with a default',
  LETTER_IRL_OAUTH_LEGACY_AUDIENCES: 'empty unless an audience is being retired',
  LETTER_IRL_DEFAULT_ORIGIN: 'with a default',
  LETTER_IRL_WIDGET_DOMAIN: 'with a default',
  LETTER_IRL_API_URL: 'with a default',
  LETTER_IRL_PACKS_URL: 'with a default',
  // Each checked by its own rule in validateDeploymentConfig; unset is the production state.
  LETTER_IRL_REQUIRE_AUTH: 'checked by its own rule; on unless set to false',
  LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY: 'checked by its own rule; off unless set',
  // Not a setting: a constant the code exports under this name.
  LETTER_IRL_SERVER_INSTRUCTIONS: 'a TypeScript constant, not an environment variable',
  // Local development only.
  LETTER_IRL_DEFAULT_USER_ID: 'local development without sign-in',
  LETTER_IRL_DEFAULT_SENDER_ADDRESS: 'local development fallback sender',
  LETTER_IRL_DEFAULT_SENDER_CITY: 'local development fallback sender',
  LETTER_IRL_DEFAULT_SENDER_STATE: 'local development fallback sender',
  LETTER_IRL_DEFAULT_SENDER_ZIP: 'local development fallback sender',
  // The admin panel's own service, which the API's manifest does not cover.
  LETTER_IRL_ADMIN_PROVISIONING_DATABASE_URL: 'admin panel service',
  LETTER_IRL_PACK_REFUND_COMMAND_ENABLED: 'admin panel service'
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

/** Whole names only: a name built from a prefix (`LETTER_IRL_OAUTH_` + key) is read through the names it builds. */
function namesRead(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles('src')) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bLETTER_IRL_[A-Z0-9_]*[A-Z0-9]\b/g)) names.add(match[0]);
  }
  return names;
}

describe('the deployment manifest names every LETTER_IRL_* setting (#682)', () => {
  const declared = new Set(ENV_VAR_MANIFEST.flatMap(entry => [entry.name, ...(entry.aliases ?? [])]));
  const read = namesRead();

  it('finds the names it is guarding', () => {
    expect(read.size).toBeGreaterThan(50);
    expect(read).toContain('LETTER_IRL_HOME_ENABLED');
  });

  it('declares each name the code reads, or lists why not', () => {
    const missing = [...read].filter(name => !declared.has(name) && !(name in NOT_IN_MANIFEST)).sort();
    expect(missing).toEqual([]);
  });

  it('declares the home and custom stationery flags', () => {
    expect(declared).toContain('LETTER_IRL_HOME_ENABLED');
    expect(declared).toContain('LETTER_IRL_CUSTOM_STATIONERY_ENABLED');
    expect(declared).toContain('LETTER_IRL_CHATGPT_PLUGIN_ID');
  });

  it('lists no name here that the code no longer reads, or that the manifest now has', () => {
    expect(Object.keys(NOT_IN_MANIFEST).filter(name => !read.has(name) || declared.has(name))).toEqual([]);
  });
});
