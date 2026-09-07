import { OperatorLoginSchema } from "../contracts.js";
import type { AdminErrorCode } from "../errors.js";
import type { WhoisClient } from "../tailscale/cli.js";
import type { AdminSession, AdminSessionStore } from "./session.js";

/**
 * Identity at the application, fail closed.
 *
 * Serve sets `Tailscale-User-Login` from its own whois of the peer and strips
 * any inbound copy, so on a listener that only the local Serve proxy can
 * reach the header is trustworthy by construction. Every check below still
 * runs on every request, and a session cookie never substitutes for them:
 * loopback socket, no Funnel marker, the header present and well formed, the
 * forwarded host equal to the node's own name (DNS-rebinding defence), the
 * login on the allowlist, and, for a new session, whois agreeing with the
 * header.
 */

export interface AuthRequestView {
  remoteAddress: string | undefined;
  header(name: string): string | undefined;
  cookie(name: string): string | undefined;
}

export interface TailscaleAuthOptions {
  allowedLogins: ReadonlySet<string>;
  /** The node's MagicDNS name, without trailing dot; null in local-dev mode. */
  expectedHost: string | null;
  whois: WhoisClient;
  sessions: AdminSessionStore;
  /** Development on a workstation: the configured login replaces the proxy. */
  localDev?: { login: string; name: string } | null;
}

export interface AuthenticatedActor {
  id: string;
  name: string;
  node: string;
}

export type AuthOutcome =
  | {
      ok: true;
      actor: AuthenticatedActor;
      session: AdminSession;
      created: boolean;
      /** The previous session id when the cookie was rejected and replaced. */
      replaced: "expired" | "binding_mismatch" | null;
    }
  | {
      ok: false;
      code: Extract<AdminErrorCode, "ADMIN_UNAUTHENTICATED" | "ADMIN_FORBIDDEN">;
      reason: string;
      presentedLogin: string | null;
    };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const NAME_MAX_LENGTH = 255;

function sanitizeDisplayName(value: string | undefined, fallback: string): string {
  const trimmed = Array.from(value ?? "")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  return trimmed.length > 0 ? trimmed.slice(0, NAME_MAX_LENGTH) : fallback;
}

function normalizeHost(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/:443$/, "")
    .replace(/\.$/, "");
}

/** The peer's tailnet address is the last entry Serve appended. */
function peerAddressFrom(forwardedFor: string | undefined): string | null {
  const last = (forwardedFor ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .at(-1);
  return last && /^[0-9A-Fa-f:.]{3,64}$/.test(last) ? last : null;
}

function denied(
  code: "ADMIN_UNAUTHENTICATED" | "ADMIN_FORBIDDEN",
  reason: string,
  presentedLogin: string | null = null,
): AuthOutcome {
  return { ok: false, code, reason, presentedLogin };
}

export async function authenticateAdminRequest(
  request: AuthRequestView,
  options: TailscaleAuthOptions,
): Promise<AuthOutcome> {
  if (!request.remoteAddress || !LOOPBACK.has(request.remoteAddress)) {
    return denied("ADMIN_UNAUTHENTICATED", "not_loopback");
  }

  let login: string;
  let name: string;
  let peerAddress: string;
  let nodeFromWhois: (() => Promise<string | null>) | null = null;

  if (options.localDev) {
    login = options.localDev.login;
    name = options.localDev.name;
    peerAddress = request.remoteAddress;
  } else {
    if (request.header("tailscale-funnel-request") !== undefined) {
      return denied("ADMIN_UNAUTHENTICATED", "funnel");
    }
    const presented = request.header("tailscale-user-login");
    const parsedLogin = OperatorLoginSchema.safeParse(presented ?? "");
    if (!presented || !parsedLogin.success) {
      return denied("ADMIN_UNAUTHENTICATED", "login_header_missing");
    }
    login = parsedLogin.data;
    const forwardedHost = normalizeHost(request.header("x-forwarded-host"));
    if (!options.expectedHost || forwardedHost !== options.expectedHost) {
      return denied("ADMIN_UNAUTHENTICATED", "host_mismatch", login);
    }
    const peer = peerAddressFrom(request.header("x-forwarded-for"));
    if (!peer) {
      return denied("ADMIN_UNAUTHENTICATED", "peer_address_missing", login);
    }
    peerAddress = peer;
    name = sanitizeDisplayName(request.header("tailscale-user-name"), login);
    const whois = options.whois;
    nodeFromWhois = async () => {
      const result = await whois.whois(peer);
      if (!result || result.login !== login) return null;
      return result.nodeName;
    };
  }

  if (!options.allowedLogins.has(login)) {
    return denied("ADMIN_FORBIDDEN", "not_allowlisted", login);
  }

  const resolution = options.sessions.resolve(
    request.cookie("__Host-lirl_admin"),
    { login, peerAddress },
  );
  if (resolution.kind === "ok") {
    const session = resolution.session;
    return {
      ok: true,
      actor: { id: session.login, name: session.name, node: session.node },
      session,
      created: false,
      replaced: null,
    };
  }

  let node = "local-dev";
  if (nodeFromWhois) {
    let resolved: string | null;
    try {
      resolved = await nodeFromWhois();
    } catch {
      resolved = null;
    }
    if (!resolved) {
      return denied("ADMIN_UNAUTHENTICATED", "whois_disagrees", login);
    }
    node = resolved;
  }
  const session = options.sessions.create({ login, name, node, peerAddress });
  return {
    ok: true,
    actor: { id: login, name, node },
    session,
    created: true,
    replaced: resolution.kind === "missing" ? null : resolution.kind,
  };
}
