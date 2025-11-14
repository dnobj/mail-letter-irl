/**
 * Configuration for ChatGPT Apps SDK with Auth0
 */

import { logger } from './logger.js';

export interface Auth0Config {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  registrationEndpoint?: string;
  clientId?: string;
  audience: string;
  scopes: string[];
}

export interface ServerConfig {
  host: string;
  port: number;
  baseUrl: string;
  ssePath: string;
  sseMessagesPath: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  auth0: Auth0Config;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvArray(key: string, defaultValue: string[]): string[] {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(): ServerConfig {
  logger.info('config', 'Loading configuration from environment variables');

  const config: ServerConfig = {
    host: getEnv('SERVER_HOST', '0.0.0.0'),
    port: parseInt(getEnv('SERVER_PORT', '8788')),
    baseUrl: getEnv('PUBLIC_BASE_URL', 'http://localhost:8788'),
    ssePath: getEnv('SSE_PATH', '/mcp/sse'),
    sseMessagesPath: getEnv('SSE_MESSAGES_PATH', '/mcp/sse/messages'),
    allowedOrigins: getEnvArray('ALLOWED_ORIGINS', [
      'https://chat.openai.com',
      'https://chatgpt.com'
    ]),
    allowedHosts: getEnvArray('ALLOWED_HOSTS', ['localhost', '127.0.0.1']),
    auth0: {
      issuer: getEnv('AUTH0_ISSUER'),
      authorizationEndpoint: getEnv('AUTH0_AUTHORIZATION_ENDPOINT'),
      tokenEndpoint: getEnv('AUTH0_TOKEN_ENDPOINT'),
      jwksUri: getEnv('AUTH0_JWKS_URI'),
      registrationEndpoint: process.env.AUTH0_REGISTRATION_ENDPOINT,
      clientId: process.env.AUTH0_CLIENT_ID,
      audience: getEnv('AUTH0_AUDIENCE'),
      scopes: getEnvArray('AUTH0_SCOPES', ['openid', 'email', 'profile'])
    }
  };

  // Add baseUrl to allowed origins if not already present
  try {
    const baseOrigin = new URL(config.baseUrl).origin;
    if (!config.allowedOrigins.includes(baseOrigin)) {
      config.allowedOrigins.push(baseOrigin);
    }
  } catch (e) {
    logger.warn('config', 'Could not parse baseUrl for origin extraction', { baseUrl: config.baseUrl });
  }

  logger.info('config', 'Configuration loaded successfully', {
    host: config.host,
    port: config.port,
    baseUrl: config.baseUrl,
    auth0Issuer: config.auth0.issuer,
    allowedOrigins: config.allowedOrigins
  });

  // Validate critical Auth0 settings
  validateConfig(config);

  return config;
}

function validateConfig(config: ServerConfig) {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Check if baseUrl is HTTPS (required for ChatGPT)
  if (!config.baseUrl.startsWith('https://') && !config.baseUrl.includes('localhost')) {
    errors.push('PUBLIC_BASE_URL must use HTTPS for ChatGPT to connect (except localhost for testing)');
  }

  // Check Auth0 issuer format
  if (!config.auth0.issuer.endsWith('/')) {
    warnings.push('AUTH0_ISSUER should end with a trailing slash per OpenID spec');
  }

  // Verify ChatGPT origins are allowed
  const requiredOrigins = ['https://chat.openai.com', 'https://chatgpt.com'];
  for (const origin of requiredOrigins) {
    if (!config.allowedOrigins.includes(origin)) {
      warnings.push(`Consider adding ${origin} to ALLOWED_ORIGINS for ChatGPT access`);
    }
  }

  // Log warnings and errors
  for (const warning of warnings) {
    logger.warn('config', `Configuration warning: ${warning}`);
  }

  for (const error of errors) {
    logger.error('config', `Configuration error: ${error}`);
  }

  if (errors.length > 0) {
    logger.error('config', 'Configuration validation failed - fix errors before proceeding');
  } else if (warnings.length === 0) {
    logger.info('config', '✅ Configuration validation passed');
  }
}
