// Read-only check of an Auth0 tenant against what Letter IRL needs (#702).
//
// The owner runs it before a promotion, with their own short-lived Management
// API token, and records the result in docs/auth0-tenant-configuration.md. It
// only reads; it prints names, counts and verdicts, never a token, a secret or
// any Action code.
//
//   $env:AUTH0_CHECK_DOMAIN = "<tenant>.us.auth0.com"
//   $token = Read-Host "Management API token" -AsSecureString
//   $env:AUTH0_CHECK_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
//     [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token))
//   npx tsx scripts/check-auth0-tenant.ts
//   Remove-Item Env:AUTH0_CHECK_TOKEN; Remove-Variable token
//
// The token needs read:actions, read:clients, read:client_grants,
// read:email_provider and read:email_templates: take it from a temporary
// machine-to-machine application holding only those (docs/launch-promotion.md
// stage 0), and delete the application afterwards. Not from the Management API's "API
// Explorer" tab, which creates a lasting application with every scope.
//
// What it checks:
//   - the Post Login flow binds both Actions whose source is in
//     docs/auth0/actions/, the linking one before the email-claim one, each
//     deployed exactly as the file (compared by hash, whitespace-normalised),
//     with nothing left undeployed;
//   - the linking Action's auth0 dependency is pinned to 7.2.0 and its three
//     secrets are present (by name);
//   - exactly one "Account Linking" application, whose Management API grant
//     is exactly read:users and update:users, and no other application holding
//     a Management API scope that writes;
//   - a custom email provider is configured and enabled, and the
//     verification email template is enabled;
//   - how many applications the tenant has, by type (Auth0's built-in "All
//     Applications" entry aside).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ACTION_FILES = {
  link: path.join(HERE, "..", "docs", "auth0", "actions", "link-verified-email.js"),
  claim: path.join(HERE, "..", "docs", "auth0", "actions", "email-claim.js"),
};
export const LINKING_SECRETS = ["AUTH0_DOMAIN", "LINKING_CLIENT_ID", "LINKING_CLIENT_SECRET"];
export const LINKING_SCOPES = ["read:users", "update:users"];
export const AUTH0_SDK_VERSION = "7.2.0";

export interface CheckResult {
  ok: boolean;
  line: string;
}

export interface BoundAction {
  name: string;
  code: string;
  allChangesDeployed?: boolean;
  dependencies?: Array<{ name: string; version?: string }>;
  secretNames?: string[];
}

export interface Auth0Client {
  client_id?: string;
  name?: string;
  app_type?: string;
  global?: boolean;
}

export interface Auth0Grant {
  client_id: string;
  audience: string;
  scope?: string[];
  /** "user" for a user-delegated grant, whose scopes act for the signed-in user only. */
  subject_type?: string;
}

/** The tenant's own Auth0 host, or null: the token goes nowhere else. */
export function checkDomain(raw: string): string | null {
  const domain = raw.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.auth0\.com$/.test(domain) ? domain : null;
}

/** A bearer token fetch can carry: anything else would be echoed in fetch's own error. */
export function tokenLooksValid(token: string): boolean {
  return /^[A-Za-z0-9._~+/=-]+$/.test(token);
}

/** Line endings and trailing whitespace do not count: the editor may change them. */
export function normalizeCode(code: string): string {
  return (
    String(code)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n+$/, "") + "\n"
  );
}

export function codeHash(code: string): string {
  return createHash("sha256").update(normalizeCode(code)).digest("hex");
}

/** The verdicts for the Post Login flow, from the bound Actions in order and the files' hashes. */
export function checkPostLoginFlow(bound: BoundAction[], expected: { link: string; claim: string }): CheckResult[] {
  const results: CheckResult[] = [];
  const position = { link: -1, claim: -1 };
  bound.forEach((action, index) => {
    const hash = codeHash(action.code ?? "");
    const kind = hash === expected.link ? "link" : hash === expected.claim ? "claim" : null;
    if (kind && position[kind] === -1) position[kind] = index;
    const file = kind === "link" ? "link-verified-email.js" : "email-claim.js";
    results.push({
      ok: kind !== null,
      line: `bound #${index + 1} "${action.name}": ${kind ? `matches ${file}` : "matches neither file in docs/auth0/actions"}`,
    });
    if (action.allChangesDeployed === false) {
      results.push({ ok: false, line: `bound #${index + 1} "${action.name}": has changes saved but not deployed` });
    }
    if (kind === "link") {
      const sdk = (action.dependencies ?? []).find((dependency) => dependency.name === "auth0");
      results.push({
        ok: sdk?.version === AUTH0_SDK_VERSION,
        line: `linking Action's auth0 dependency: ${sdk ? sdk.version : "absent"} (expected ${AUTH0_SDK_VERSION})`,
      });
      const missing = LINKING_SECRETS.filter((name) => !(action.secretNames ?? []).includes(name));
      results.push({
        ok: missing.length === 0,
        line: missing.length === 0 ? "linking Action's secrets: all three present" : `linking Action's secrets missing: ${missing.join(", ")}`,
      });
    }
  });
  results.push({ ok: position.link !== -1, line: `the linking Action is ${position.link !== -1 ? "" : "NOT "}in the Post Login flow` });
  results.push({ ok: position.claim !== -1, line: `the email-claim Action is ${position.claim !== -1 ? "" : "NOT "}in the Post Login flow` });
  if (position.link !== -1 && position.claim !== -1) {
    results.push({
      ok: position.link < position.claim,
      line:
        position.link < position.claim
          ? "the linking Action runs before the email-claim Action"
          : "the email-claim Action runs BEFORE the linking Action",
    });
  }
  return results;
}

/**
 * The linking application's Management API grant, and every other application
 * holding one: those may only read (the check's own temporary application does).
 */
export function checkLinkingGrant(clients: Auth0Client[], grants: Auth0Grant[], managementAudience: string): CheckResult[] {
  const results: CheckResult[] = [];
  const linking = clients.filter((client) => /^Account Linking\b/.test(client.name ?? ""));
  const managementGrants = grants.filter((candidate) => candidate.audience === managementAudience);
  if (linking.length !== 1) {
    results.push({ ok: false, line: `"Account Linking" applications: ${linking.length} (expected exactly 1)` });
  } else {
    const grant = managementGrants.find(
      (candidate) => candidate.client_id === linking[0].client_id && candidate.subject_type !== "user",
    );
    if (!grant) {
      results.push({ ok: false, line: `"${linking[0].name}" has no Management API grant` });
    } else {
      const scopes = [...(grant.scope ?? [])].sort();
      const exact = scopes.length === LINKING_SCOPES.length && LINKING_SCOPES.every((scope) => scopes.includes(scope));
      results.push({
        ok: exact,
        line: `"${linking[0].name}" Management API scopes: ${scopes.join(" ") || "(none)"}${exact ? "" : ` (expected exactly ${LINKING_SCOPES.join(" ")})`}`,
      });
    }
  }
  const linkingIds = new Set(linking.map((client) => client.client_id));
  for (const grant of managementGrants) {
    if (linkingIds.has(grant.client_id)) continue;
    const name = clients.find((client) => client.client_id === grant.client_id)?.name ?? "an unlisted application";
    if (grant.subject_type === "user") {
      // Legacy clients carry these: scopes on the signed-in user's own record only.
      const beyondSelf = (grant.scope ?? []).filter((scope) => !scope.includes("current_user"));
      results.push({
        ok: beyondSelf.length === 0,
        line:
          beyondSelf.length === 0
            ? `"${name}" holds a user-delegated Management API grant (${(grant.scope ?? []).length} scopes, on the signed-in user only)`
            : `"${name}" holds a user-delegated Management API grant reaching past the signed-in user (${beyondSelf.length} of ${(grant.scope ?? []).length} scopes)`,
      });
      continue;
    }
    const writes = (grant.scope ?? []).filter((scope) => !scope.startsWith("read:"));
    results.push({
      ok: writes.length === 0,
      line:
        writes.length === 0
          ? `"${name}" also holds a Management API grant, read only (${(grant.scope ?? []).length} scopes)`
          : `"${name}" also holds a Management API grant that writes (${writes.length} of ${(grant.scope ?? []).length} scopes)`,
    });
  }
  return results;
}

export function countApplications(clients: Auth0Client[]): string {
  const byType = new Map<string, number>();
  for (const client of clients.filter((candidate) => candidate.global !== true)) {
    const type = client.app_type ?? "unset";
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  return [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
}

async function main(): Promise<void> {
  const domain = checkDomain(process.env.AUTH0_CHECK_DOMAIN ?? "");
  const token = (process.env.AUTH0_CHECK_TOKEN ?? "").trim();
  if (!domain || !token) {
    console.error("Set AUTH0_CHECK_DOMAIN to the tenant's own *.auth0.com host, and AUTH0_CHECK_TOKEN (see the header of this file).");
    process.exit(2);
  }
  if (!tokenLooksValid(token)) {
    console.error("AUTH0_CHECK_TOKEN holds characters a token does not have; set it again (see the header of this file).");
    process.exit(2);
  }
  const base = `https://${domain}/api/v2`;
  async function get(pathAndQuery: string): Promise<any> {
    const response = await fetch(base + pathAndQuery, {
      headers: { authorization: `Bearer ${token}` },
      // The token goes to the tenant's own host only: a redirect elsewhere is refused, not followed.
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // The status only: a body could echo request details.
      throw new Error(`GET ${pathAndQuery.split("?")[0]} answered ${response.status}`);
    }
    return response.json();
  }
  async function getAll<T>(pathAndQuery: string, key: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 0; page < 50; page += 1) {
      const separator = pathAndQuery.includes("?") ? "&" : "?";
      const body = await get(`${pathAndQuery}${separator}per_page=100&page=${page}&include_totals=true`);
      const batch: T[] = body[key] ?? [];
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  const results: CheckResult[] = [];
  const expected = {
    link: codeHash(readFileSync(ACTION_FILES.link, "utf8")),
    claim: codeHash(readFileSync(ACTION_FILES.claim, "utf8")),
  };

  const bindings: Array<{ display_name?: string; action: { id: string } }> =
    (await get("/actions/triggers/post-login/bindings")).bindings ?? [];
  const bound: BoundAction[] = [];
  for (const binding of bindings) {
    const action = await get(`/actions/actions/${encodeURIComponent(binding.action.id)}`);
    let code: string | undefined = action.deployed_version?.code;
    if (code === undefined && action.deployed_version?.id) {
      const version = await get(
        `/actions/actions/${encodeURIComponent(action.id)}/versions/${encodeURIComponent(action.deployed_version.id)}`,
      );
      code = version.code;
    }
    bound.push({
      name: binding.display_name || action.name,
      code: code ?? "",
      allChangesDeployed: action.all_changes_deployed,
      dependencies: action.deployed_version?.dependencies ?? action.dependencies ?? [],
      secretNames: (action.secrets ?? []).map((secret: { name: string }) => secret.name),
    });
  }
  results.push(...checkPostLoginFlow(bound, expected));

  const managementAudience = `https://${domain}/api/v2/`;
  const clients = await getAll<Auth0Client>("/clients?fields=client_id,name,app_type,global&include_fields=true", "clients");
  const grants = await getAll<Auth0Grant>(`/client-grants?audience=${encodeURIComponent(managementAudience)}`, "client_grants");
  results.push(...checkLinkingGrant(clients, grants, managementAudience));

  try {
    const provider = await get("/emails/provider?fields=name,enabled&include_fields=true");
    results.push({ ok: provider.enabled === true, line: `email provider: ${provider.name ?? "unknown"}, ${provider.enabled ? "enabled" : "NOT enabled"}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ ok: false, line: `email provider: ${message.includes("404") ? "none configured (Auth0's built-in, trial only)" : message}` });
  }
  try {
    const template = await get("/email-templates/verify_email");
    results.push({ ok: template.enabled === true, line: `verification email template: ${template.enabled ? "enabled" : "NOT enabled"}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ ok: false, line: `verification email template: ${message.includes("404") ? "not configured" : message}` });
  }

  console.log(`Auth0 tenant ${domain}, ${new Date().toISOString()}`);
  console.log(`  repository files: link-verified-email.js ${expected.link.slice(0, 12)}, email-claim.js ${expected.claim.slice(0, 12)}`);
  for (const result of results) console.log(`  ${result.ok ? "ok   " : "CHECK"} ${result.line}`);
  console.log(`  applications: ${clients.filter((client) => client.global !== true).length} (${countApplications(clients)})`);
  const failures = results.filter((result) => !result.ok).length;
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) need attention.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
