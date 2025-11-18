/**
 * Letter Fulfillment Provider Factory
 *
 * Manages provider registration and instantiation.
 * Allows switching between providers via environment configuration.
 */

import type {
  LetterFulfillmentProvider,
  ProviderConfig,
  ProviderFactory
} from './types.js';
import { DummyProvider } from './DummyProvider.js';
import { PostGridProvider } from './PostGridProvider.js';

/**
 * Registry of available providers
 */
const providerRegistry = new Map<string, ProviderFactory>();

/**
 * Cached provider instance (singleton pattern)
 */
let cachedProvider: LetterFulfillmentProvider | null = null;

/**
 * Register a provider factory
 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  providerRegistry.set(name.toLowerCase(), factory);
  console.log(`✅ Registered letter provider: ${name}`);
}

/**
 * Get provider factory by name
 */
export function getProviderFactory(name: string): ProviderFactory | undefined {
  return providerRegistry.get(name.toLowerCase());
}

/**
 * List all registered providers
 */
export function listProviders(): string[] {
  return Array.from(providerRegistry.keys());
}

/**
 * Create a provider instance
 */
export function createProvider(config: ProviderConfig): LetterFulfillmentProvider {
  const factory = getProviderFactory(config.name);

  if (!factory) {
    throw new Error(
      `Unknown provider: ${config.name}. Available providers: ${listProviders().join(', ')}`
    );
  }

  if (!config.enabled) {
    throw new Error(`Provider ${config.name} is disabled in configuration`);
  }

  return factory(config);
}

/**
 * Get the configured letter fulfillment provider
 *
 * Reads configuration from environment variables:
 * - LETTER_PROVIDER: Provider name (default: "dummy")
 * - LETTER_PROVIDER_API_KEY: API key for the provider
 * - LETTER_PROVIDER_CONFIG: JSON string with additional config
 */
export function getLetterProvider(): LetterFulfillmentProvider {
  if (cachedProvider) {
    return cachedProvider;
  }

  const providerName = process.env.LETTER_PROVIDER || 'dummy';
  const apiKey = process.env.LETTER_PROVIDER_API_KEY;
  const configJson = process.env.LETTER_PROVIDER_CONFIG;

  // Parse additional config
  let additionalConfig: Record<string, any> = {};
  if (configJson) {
    try {
      additionalConfig = JSON.parse(configJson);
    } catch (error) {
      console.warn('⚠️  Failed to parse LETTER_PROVIDER_CONFIG:', error);
    }
  }

  // Build provider config
  const config: ProviderConfig = {
    name: providerName,
    displayName: getProviderDisplayName(providerName),
    enabled: true,
    credentials: apiKey ? { apiKey } : undefined,
    config: additionalConfig
  };

  cachedProvider = createProvider(config);

  console.log(`✅ Initialized letter provider: ${config.displayName}`);

  return cachedProvider;
}

/**
 * Reset cached provider (useful for testing)
 */
export function resetProvider(): void {
  cachedProvider = null;
  console.log('🔄 Reset cached letter provider');
}

/**
 * Get display name for a provider
 */
function getProviderDisplayName(name: string): string {
  const displayNames: Record<string, string> = {
    dummy: 'Dummy Provider (Testing)',
    lob: 'Lob',
    postgrid: 'PostGrid',
    click2mail: 'Click2Mail'
  };

  return displayNames[name.toLowerCase()] || name;
}

/**
 * Initialize provider registry with built-in providers
 */
function initializeProviders(): void {
  // Register DummyProvider
  registerProvider('dummy', (config) => {
    const options = {
      delayMs: config.config?.delayMs ?? 1000,
      failureRate: config.config?.failureRate ?? 0.05,
      costCents: config.config?.costCents ?? 100,
      deliveryDays: config.config?.deliveryDays ?? 3,
      verbose: config.config?.verbose ?? true
    };

    return new DummyProvider(config, options);
  });

  // Register PostGridProvider
  registerProvider('postgrid', (config) => {
    if (!config.credentials?.apiKey) {
      throw new Error('PostGrid API key is required. Set LETTER_PROVIDER_API_KEY environment variable.');
    }

    const options = {
      apiKey: config.credentials.apiKey,
      mode: config.config?.mode ?? 'test',
      verbose: config.config?.verbose ?? true,
      baseUrl: config.config?.baseUrl
    };

    return new PostGridProvider(config, options);
  });

  // TODO: Register other providers as they're implemented
  // registerProvider('lob', (config) => new LobProvider(config));
  // registerProvider('click2mail', (config) => new Click2MailProvider(config));
}

// Initialize built-in providers
initializeProviders();

/**
 * Re-export types for convenience
 */
export type {
  LetterFulfillmentProvider,
  LetterParams,
  LetterResult,
  LetterStatus,
  CostEstimate,
  ProviderConfig
} from './types.js';

export { DummyProvider } from './DummyProvider.js';
export { PostGridProvider } from './PostGridProvider.js';
