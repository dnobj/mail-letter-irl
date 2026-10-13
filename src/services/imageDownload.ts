/**
 * How a remote image is reached (#730): its host resolved off the libuv
 * thread pool under the download's deadline, every address it resolves to
 * checked, and the connection made to the address that was checked.
 *
 * Before, `dns.lookup` ran getaddrinfo on one of the pool's four threads with
 * no deadline of its own: a name whose nameserver never answers held a thread
 * past the download's 20 seconds, and a few such names could stall every
 * other user of the pool (image decodes, fs, crypto, zlib, and the lookups
 * for the database, Stripe, PostGrid and Auth0). And `fetch` resolved the
 * name again, so the address checked need not be the address reached.
 *
 * c-ares (`dns.promises.Resolver`) asks the nameservers itself, on the event
 * loop, and is cancelled when the deadline passes. It does not read
 * /etc/hosts, which a remote image never needs.
 */

import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import type { LookupAddress, LookupOneOptions } from 'node:dns';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/** An address a download may connect to: one its host resolved to, checked. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Per query: c-ares backs off between tries, and the deadline cancels it.
 * Once the A query has answered, the AAAA query has `aaaaGraceMs` more: a
 * nameserver that drops AAAA queries must not hold an IPv4 download.
 */
export const DNS_CONFIG = { timeoutMs: 4_000, tries: 2, aaaaGraceMs: 1_500 } as const;

type Answer = { ok: true; addresses: string[] } | { ok: false; code?: string };

function answerOf(query: Promise<string[]>): Promise<Answer> {
  return query.then(
    addresses => ({ ok: true as const, addresses }),
    (error: NodeJS.ErrnoException) => ({ ok: false as const, code: error?.code })
  );
}

/** The host has no such record, as opposed to a query that failed. */
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND']);

/** What resolution needs from a resolver: so tests can stand one in. */
export interface ImageHostResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel(): void;
}

function defaultResolver(): ImageHostResolver {
  return new Resolver({ timeout: DNS_CONFIG.timeoutMs, tries: DNS_CONFIG.tries });
}

/**
 * The addresses to connect to for `host`, IPv4 first, or null: when it
 * resolves to nothing, when any address it resolves to is not public (a host
 * cannot be half safe), when the A query failed rather than found no record
 * (an IPv6-only pin would then stand in for a host that has IPv4), or when
 * the deadline passes first. An AAAA answer later than the grace is left out,
 * and so is never connected to.
 */
export async function resolvePublicAddress(
  host: string,
  signal: AbortSignal,
  makeResolver: () => ImageHostResolver = defaultResolver
): Promise<PinnedAddress[] | null> {
  if (signal.aborted) return null;
  // One resolver each, so the AAAA query can be cancelled alone.
  const v4Resolver = makeResolver();
  const v6Resolver = makeResolver();
  const cancel = () => {
    v4Resolver.cancel();
    v6Resolver.cancel();
  };
  signal.addEventListener('abort', cancel, { once: true });
  let grace: ReturnType<typeof setTimeout> | undefined;
  try {
    const aaaa = answerOf(v6Resolver.resolve6(host));
    const a = await answerOf(v4Resolver.resolve4(host));
    if (!a.ok && !NO_RECORD.has(a.code ?? '')) return null;
    const four = a.ok ? a.addresses : [];
    const six = await (four.length > 0
      ? Promise.race([
          aaaa,
          new Promise<Answer>(resolve => {
            grace = setTimeout(() => {
              v6Resolver.cancel();
              resolve({ ok: false });
            }, DNS_CONFIG.aaaaGraceMs);
          })
        ])
      : aaaa
    ).then(answer => (answer.ok ? answer.addresses : []));
    if (signal.aborted) return null;
    if (four.length + six.length === 0) return null;
    if ([...four, ...six].some(isUnsafeIpAddress)) return null;
    return [
      ...four.map(address => ({ address, family: 4 as const })),
      ...six.map(address => ({ address, family: 6 as const }))
    ];
  } finally {
    clearTimeout(grace);
    signal.removeEventListener('abort', cancel);
  }
}

// ============================================================================
// Which addresses are not public
// ============================================================================

export function isUnsafeIpAddress(address: string): boolean {
  const ipVersion = isIP(address);
  if (ipVersion === 4) return isUnsafeIpv4Address(address);
  if (ipVersion === 6) return isUnsafeIpv6Address(address);
  return false;
}

export function isUnsafeIpv4Address(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
export function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  // A trailing dotted IPv4 (::ffff:1.2.3.4, ::1.2.3.4) is two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (isIP(dotted[2]) !== 4) return null;
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map(group => Number.parseInt(group, 16));
}

/**
 * Not public: all of ::/8 (unspecified, loopback, IPv4-mapped, -compatible
 * and -translated, and NAT64's 64:ff9b::/96 and 64:ff9b:1::/48: nothing
 * global lives there), unique local, link and site local, multicast,
 * documentation (2001:db8::/32, 3fff::/20), 6to4 (2002::/16), the IETF
 * protocol block holding Teredo (2001::/23), discard (100::/64) and SRv6
 * (5f00::/16).
 */
export function isUnsafeIpv6Address(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return true;
  const [g0, g1, g2, g3] = g;
  return (
    g0 <= 0x00ff ||
    (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xffc0) === 0xfec0 ||
    (g0 & 0xff00) === 0xff00 ||
    (g0 === 0x2001 && g1 === 0x0db8) ||
    (g0 === 0x3fff && g1 < 0x1000) ||
    g0 === 0x2002 ||
    (g0 === 0x2001 && g1 < 0x0200) ||
    (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) ||
    g0 === 0x5f00
  );
}

// ============================================================================
// The connection
// ============================================================================

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * One GET to `url`, connected to `pinned` whatever the name resolves to now.
 * TLS still names and verifies the host. No connection is pooled: a pooled
 * socket is keyed by host, not by the address it reached.
 */
function requestPinned(url: string, init: { signal: AbortSignal; pinned: PinnedAddress[] }): Promise<Response> {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const pinned = init.pinned;
  if (pinned.length === 0) return Promise.reject(new Error('no address'));
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(
      {
        host,
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { accept: '*/*', 'user-agent': 'node' },
        servername: isIP(host) ? undefined : host,
        agent: false,
        signal: init.signal,
        lookup: ((
          _hostname: string,
          options: LookupOneOptions & { all?: boolean },
          callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void
        ) => {
          // Every checked address, for happy eyeballs; the first otherwise.
          if (options?.all) callback(null, pinned.map(({ address, family }) => ({ address, family })));
          else callback(null, pinned[0].address, pinned[0].family);
        }) as never
      },
      response => {
        const status = response.statusCode ?? 0;
        try {
          if (status < 200 || status > 599) throw new Error(`status ${status}`);
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
          }
          const body = NULL_BODY_STATUSES.has(status)
            ? null
            : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>);
          if (!body) response.resume();
          resolve(new Response(body, { status, headers }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      }
    );
    request.on('error', reject);
    request.end();
  });
}

/** How a download reaches its host. Tests stand in for `fetch`. */
export const remoteImageTransport = {
  fetch: requestPinned as (url: string, init: { signal: AbortSignal; pinned: PinnedAddress[] }) => Promise<Response>
};
