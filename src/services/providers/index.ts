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
import { DIYProvider } from './DIYProvider.js';
import { query } from '../../db/index.js';

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
 * Cache for providers by name (allows multiple providers to be active)
 */
const providersByName = new Map<string, LetterFulfillmentProvider>();

/**
 * Get a provider by name
 *
 * Creates and caches a provider instance for the given name.
 * Falls back to default provider if the requested one isn't configured.
 */
export function getProviderByName(providerName: string): LetterFulfillmentProvider {
  const normalizedName = providerName.toLowerCase();

  // Check cache first
  if (providersByName.has(normalizedName)) {
    return providersByName.get(normalizedName)!;
  }

  // Build provider config based on provider name
  const apiKey = providerName === 'postgrid'
    ? process.env.POSTGRID_API_KEY || process.env.LETTER_PROVIDER_API_KEY
    : providerName === 'lob'
      ? process.env.LOB_API_KEY
      : providerName === 'diy'
        ? process.env.DIY_ADMIN_SECRET
        : undefined;

  const configJson = process.env.LETTER_PROVIDER_CONFIG;
  let additionalConfig: Record<string, any> = {};
  if (configJson) {
    try {
      additionalConfig = JSON.parse(configJson);
    } catch (error) {
      console.warn('⚠️  Failed to parse LETTER_PROVIDER_CONFIG:', error);
    }
  }

  const config: ProviderConfig = {
    name: normalizedName,
    displayName: getProviderDisplayName(normalizedName),
    enabled: true,
    credentials: apiKey ? { apiKey } : undefined,
    config: additionalConfig
  };

  try {
    const provider = createProvider(config);
    providersByName.set(normalizedName, provider);
    console.log(`✅ Initialized provider by name: ${config.displayName}`);
    return provider;
  } catch (error) {
    console.warn(`⚠️  Failed to create provider ${providerName}, falling back to default:`, error);
    return getLetterProvider();
  }
}

/**
 * Valid mail types for routing
 */
export type MailType = 'text_only_letter' | 'header_image_letter' | 'inline_image_letter' | 'postcard';

/**
 * Get the provider name for a specific mail type from the routing table
 *
 * Falls back to environment default if no routing rule exists or is disabled.
 */
export async function getProviderRouting(mailType: MailType): Promise<string> {
  try {
    const result = await query(
      'SELECT provider FROM provider_routing WHERE mail_type = $1 AND enabled = true',
      [mailType]
    );

    if (result.rows.length > 0) {
      const providerName = result.rows[0].provider;
      console.log(`📋 Routing ${mailType} → ${providerName} (from database)`);
      return providerName;
    }
  } catch (error) {
    console.warn(`⚠️  Failed to get routing for ${mailType}:`, error);
  }

  // Fall back to default provider
  const defaultProvider = process.env.LETTER_PROVIDER || 'postgrid';
  console.log(`📋 Routing ${mailType} → ${defaultProvider} (default fallback)`);
  return defaultProvider;
}

/**
 * Get a provider instance based on mail type routing
 *
 * Combines routing lookup with provider instantiation.
 */
export async function getProviderForMailType(mailType: MailType): Promise<LetterFulfillmentProvider> {
  const providerName = await getProviderRouting(mailType);
  return getProviderByName(providerName);
}

/**
 * Get display name for a provider
 */
function getProviderDisplayName(name: string): string {
  const displayNames: Record<string, string> = {
    dummy: 'Dummy Provider (Testing)',
    lob: 'Lob',
    postgrid: 'PostGrid',
    click2mail: 'Click2Mail',
    diy: 'DIY (Manual Print)'
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

  // Register DIYProvider
  registerProvider('diy', (config) => {
    const serviceUrl = process.env.DIY_SERVICE_URL;
    if (!serviceUrl) {
      throw new Error('DIY_SERVICE_URL environment variable is required for DIY provider.');
    }

    const options = {
      serviceUrl,
      adminSecret: process.env.DIY_ADMIN_SECRET,
      verbose: config.config?.verbose ?? true
    };

    return new DIYProvider(config, options);
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
export { DIYProvider } from './DIYProvider.js';
