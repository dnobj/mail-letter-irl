/**
 * Versioned widget template URIs.
 *
 * The native ChatGPT mobile apps cache widget metadata far more aggressively
 * than web and do not reliably pick up the web connector's Refresh (issue
 * #235; community-endorsed mitigation). Versioning the resource URI forces
 * every client to fetch fresh templates when widgets change.
 *
 * Bump WIDGET_TEMPLATE_VERSION whenever any widget HTML or widget-facing
 * metadata changes. Tool outputTemplate references and the registered
 * resource URIs must always agree, so both go through widgetTemplateUri().
 *
 * registerWidgetResources also serves a ui://widgets/{name}.html@v{version}
 * template, so a client cached at an older version still gets its widget and a
 * missed bump no longer strands anyone - it just serves current HTML under an
 * old URI. Bumping is still what forces caches to re-fetch, so keep doing it;
 * the template is a floor, not a replacement.
 */
export const WIDGET_TEMPLATE_VERSION = 22;

export function widgetTemplateUri(name: string): string {
  return `ui://widgets/${name}.html@v${WIDGET_TEMPLATE_VERSION}`;
}
