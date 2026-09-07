/**
 * A small route table: static paths win over parameter paths regardless of
 * registration order, which is the defect the legacy dispatcher had (its
 * `startsWith('/api/admin/users/')` test shadowed `/api/admin/users/search`).
 */

export type RouteMethod = "GET" | "POST";

export interface RouteDefinition<H> {
  method: RouteMethod;
  pattern: string;
  handler: H;
  /** State-changing routes: POST only, with the browser-boundary checks. */
  write: boolean;
  name: string;
}

export type RouteMatch<H> =
  | { kind: "match"; route: RouteDefinition<H>; params: Record<string, string> }
  | { kind: "method_not_allowed" }
  | { kind: "not_found" };

const PARAM_MAX_LENGTH = 255;
// Printable ASCII without slashes; ids in this system are opaque strings,
// UUIDs, Auth0 subjects ("auth0|abc") and Stripe ids.
const PARAM_PATTERN = /^[\x21-\x2e\x30-\x7e]{1,255}$/;

interface CompiledRoute<H> {
  definition: RouteDefinition<H>;
  segments: string[];
  isStatic: boolean;
}

export class AdminRouter<H> {
  private readonly routes: CompiledRoute<H>[] = [];

  add(
    method: RouteMethod,
    pattern: string,
    handler: H,
    options: { write?: boolean; name?: string } = {},
  ): this {
    if (!pattern.startsWith("/")) throw new Error("route pattern must start with /");
    const segments = pattern.split("/").slice(1);
    this.routes.push({
      definition: {
        method,
        pattern,
        handler,
        write: options.write ?? method === "POST",
        name: options.name ?? pattern,
      },
      segments,
      isStatic: !segments.some((segment) => segment.startsWith(":")),
    });
    return this;
  }

  match(method: string, pathname: string): RouteMatch<H> {
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    const segments = path.split("/").slice(1);
    let sawPathMatch = false;
    const candidates = [
      ...this.routes.filter((route) => route.isStatic),
      ...this.routes.filter((route) => !route.isStatic),
    ];
    for (const route of candidates) {
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      sawPathMatch = true;
      if (route.definition.method !== method) continue;
      return { kind: "match", route: route.definition, params };
    }
    return sawPathMatch ? { kind: "method_not_allowed" } : { kind: "not_found" };
  }
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const value = actual[index];
    if (expected.startsWith(":")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        return null;
      }
      if (
        decoded.length === 0 ||
        decoded.length > PARAM_MAX_LENGTH ||
        !PARAM_PATTERN.test(decoded)
      ) {
        return null;
      }
      params[expected.slice(1)] = decoded;
    } else if (expected !== value) {
      return null;
    }
  }
  return params;
}
