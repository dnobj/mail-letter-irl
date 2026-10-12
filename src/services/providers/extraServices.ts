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

/**
 * The registered providers that print mail our renderer drew (#698), by name,
 * for the same kind of decision. Each provider also says so itself
 * (`printsRenderedPdf`, which the dispatch asks); a test holds the two together.
 */
const RENDERED_PDF_PROVIDER_NAMES: ReadonlySet<string> = new Set(['postgrid', 'dummy']);

export function providerPrintsRenderedPdf(name: string): boolean {
  return RENDERED_PDF_PROVIDER_NAMES.has(name.toLowerCase());
}

/**
 * Whether a letter's content says our renderer drew it (#534): it records a
 * rendererVersion, of any value. The print reads it the same way (PostGrid's
 * `rendererVersion != null`), so an empty or unknown version is drawn mail too.
 */
export function drawnByRenderer(content: unknown): boolean {
  const renderer = (content as Record<string, unknown> | null | undefined)?.rendererVersion;
  return renderer !== undefined && renderer !== null;
}
