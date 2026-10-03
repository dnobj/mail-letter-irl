/**
 * The registered providers that sell extra services such as certified mail
 * (#625), by name: for a decision that names a provider without constructing it,
 * such as an operator resolving an ambiguous job as accepted by one. Each
 * provider also says so itself (`supportsExtraServices`, which the dispatch
 * asks); a test holds the two together.
 */
const EXTRA_SERVICE_PROVIDER_NAMES: ReadonlySet<string> = new Set(['postgrid', 'dummy']);

export function providerSellsExtraServices(name: string): boolean {
  return EXTRA_SERVICE_PROVIDER_NAMES.has(name.toLowerCase());
}
