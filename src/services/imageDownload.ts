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

/** The address a download connects to: one its host resolved to, checked. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/** Per query: c-ares backs off between tries, and the deadline cancels it. */
export const DNS_CONFIG = { timeoutMs: 4_000, tries: 2 } as const;

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
 * The address to connect to for `host`, or null: when it resolves to nothing,
 * when any address it resolves to is not public (a host cannot be half safe),
 * or when the deadline passes first. IPv4 is preferred when there is one.
 */
export async function resolvePublicAddress(
  host: string,
  signal: AbortSignal,
  makeResolver: () => ImageHostResolver = defaultResolver
): Promise<PinnedAddress | null> {
  if (signal.aborted) return null;
  const resolver = makeResolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    if (signal.aborted) return null;
    const four = v4.status === 'fulfilled' ? v4.value : [];
    const six = v6.status === 'fulfilled' ? v6.value : [];
    if (four.length + six.length === 0) return null;
    if ([...four, ...six].some(isUnsafeIpAddress)) return null;
    return four.length > 0 ? { address: four[0], family: 4 } : { address: six[0], family: 6 };
  } finally {
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
 * Not public: unspecified, loopback, IPv4-mapped and IPv4-compatible, unique
 * local, link and site local, multicast, documentation (2001:db8::/32,
 * 3fff::/20), and the ranges that carry an IPv4 address or reach one through
 * a translator: NAT64 (64:ff9b::/96, 64:ff9b:1::/48), 6to4 (2002::/16), and
 * the IETF protocol block holding Teredo (2001::/23). Also discard
 * (100::/64) and SRv6 (5f00::/16).
 */
export function isUnsafeIpv6Address(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5] = g;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  return (
    (firstFiveZero && (g5 === 0 || g5 === 0xffff)) ||
    (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xffc0) === 0xfec0 ||
    (g0 & 0xff00) === 0xff00 ||
    (g0 === 0x2001 && g1 === 0x0db8) ||
    (g0 === 0x3fff && g1 < 0x1000) ||
    (g0 === 0x0064 && g1 === 0xff9b) ||
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
function requestPinned(url: string, init: { signal: AbortSignal; pinned: PinnedAddress }): Promise<Response> {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const { address, family } = init.pinned;
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
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
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
  fetch: requestPinned as (url: string, init: { signal: AbortSignal; pinned: PinnedAddress }) => Promise<Response>
};
