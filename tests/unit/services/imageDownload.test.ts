import https from 'node:https';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DNS_CONFIG,
  ipv6Groups,
  isUnsafeIpAddress,
  isUnsafeIpv6Address,
  remoteImageTransport,
  resolvePublicAddress,
  type ImageHostResolver
} from '../../../src/services/imageDownload.js';
import { _testing as imageServiceTesting } from '../../../src/services/imageService.js';

type Reply = string[] | 'hang' | { code: string };

/** A resolver that answers each query from a table, fails it, or never answers. */
function resolverOf(four: Reply, six: Reply = { code: 'ENODATA' }) {
  const cancel = vi.fn();
  const hanging: Array<(error: Error) => void> = [];
  const reply = (value: Reply) =>
    value === 'hang'
      ? new Promise<string[]>((_resolve, reject) => {
          hanging.push(reject);
        })
      : Array.isArray(value)
        ? Promise.resolve(value)
        : Promise.reject(Object.assign(new Error(value.code), { code: value.code }));
  const resolver: ImageHostResolver = {
    resolve4: () => reply(four),
    resolve6: () => reply(six),
    cancel: () => {
      cancel();
      for (const reject of hanging.splice(0)) reject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
    }
  };
  return { resolver, cancel };
}

const V4 = '93.184.216.34';
const V6 = '2606:2800:220:1:248:1893:25c8:1946';

describe('image hosts resolve off the thread pool, every address checked (#730)', () => {
  const live = () => new AbortController().signal;
  afterEach(() => vi.useRealTimers());

  it('pins every address, IPv4 first', async () => {
    const { resolver } = resolverOf([V4, '93.184.216.35'], [V6]);
    await expect(resolvePublicAddress('example.test', live(), () => resolver)).resolves.toEqual([
      { address: V4, family: 4 },
      { address: '93.184.216.35', family: 4 },
      { address: V6, family: 6 }
    ]);
  });

  it('takes IPv6 when the host has no A record', async () => {
    for (const four of [[], { code: 'ENODATA' }, { code: 'ENOTFOUND' }] as Reply[]) {
      const { resolver } = resolverOf(four, [V6]);
      await expect(resolvePublicAddress('example.test', live(), () => resolver)).resolves.toEqual([{ address: V6, family: 6 }]);
    }
  });

  it('refuses when the A query failed rather than found nothing, not pinning IPv6 alone', async () => {
    const { resolver } = resolverOf({ code: 'ETIMEOUT' }, [V6]);
    await expect(resolvePublicAddress('example.test', live(), () => resolver)).resolves.toBeNull();
  });

  it('does not let an AAAA query that never answers hold an IPv4 download', async () => {
    vi.useFakeTimers();
    const { resolver, cancel } = resolverOf([V4], 'hang');
    const pending = resolvePublicAddress('example.test', live(), () => resolver);
    await vi.advanceTimersByTimeAsync(DNS_CONFIG.aaaaGraceMs);
    await expect(pending).resolves.toEqual([{ address: V4, family: 4 }]);
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    ['a private address', ['10.0.0.5'], { code: 'ENODATA' }],
    ['one private address among public ones', [V4, '127.0.0.1'], { code: 'ENODATA' }],
    ['a NAT64 address beside a public one', [V4], ['64:ff9b::7f00:1']],
    ['no address', [], { code: 'ENODATA' }]
  ] as Array<[string, Reply, Reply]>)('refuses a host with %s', async (_label, four, six) => {
    const { resolver } = resolverOf(four, six);
    await expect(resolvePublicAddress('example.test', live(), () => resolver)).resolves.toBeNull();
  });

  it('gives up when the deadline passes, cancelling the queries', async () => {
    const { resolver, cancel } = resolverOf('hang', 'hang');
    const controller = new AbortController();
    const pending = resolvePublicAddress('slow.test', controller.signal, () => resolver);
    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it('drops an answer that arrives after the deadline', async () => {
    let answer: (addresses: string[]) => void = () => undefined;
    const resolver: ImageHostResolver = {
      resolve4: () =>
        new Promise<string[]>(resolve => {
          answer = resolve;
        }),
      resolve6: () => Promise.resolve([]),
      cancel: () => undefined
    };
    const controller = new AbortController();
    const pending = resolvePublicAddress('late.test', controller.signal, () => resolver);
    controller.abort();
    answer([V4]);
    await expect(pending).resolves.toBeNull();
  });

  it('asks nothing once the deadline has passed', async () => {
    const controller = new AbortController();
    controller.abort();
    const make = vi.fn();
    await expect(resolvePublicAddress('example.test', controller.signal, make)).resolves.toBeNull();
    expect(make).not.toHaveBeenCalled();
  });
});

describe('addresses that are not public (#730)', () => {
  it.each([
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '::a00:1', '::ffff:0:7f00:1',
    '0:0:0:0:ffff::1', '::1:0:0:0', 'ff:1::1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1',
    '2001:db8::1', '3fff::1', '64:ff9b::7f00:1', '64:ff9b:1::a00:1', '2002:7f00:1::1',
    '2001::1', '2001:0:4136:e378::1', '2001:1ff::1', '100::1', '100:0:0:0:ffff::1', '5f00::1'
  ])('%s is refused', address => {
    expect(isUnsafeIpAddress(address)).toBe(true);
  });

  it.each([V6, '2a00:1450:4009:81f::200e', '2001:4860:4860::8888', '2001:200::1', '100:1::1', '3fff:1000::1'])(
    '%s is public',
    address => {
      expect(isUnsafeIpAddress(address)).toBe(false);
    }
  );

  it('refuses what it cannot read as an IPv6 address', () => {
    for (const text of ['1::2::3', 'zzzz::1', '1:2:3']) expect(isUnsafeIpv6Address(text), text).toBe(true);
  });

  it('reads every IPv6 spelling as its eight groups', () => {
    expect(ipv6Groups('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Groups('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(ipv6Groups('2001:db8::')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Groups('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ipv6Groups('1::2::3')).toBeNull();
    expect(ipv6Groups('1:2:3:4:5:6:7')).toBeNull();
    expect(ipv6Groups('1:2:3')).toBeNull();
    expect(ipv6Groups('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(ipv6Groups('12345::')).toBeNull();
    expect(ipv6Groups('::1.2.3.256')).toBeNull();
  });
});

describe('the connection goes to the addresses that were checked (#730)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pins the lookup, keeps the host for TLS, and pools nothing', async () => {
    const request = Object.assign(new EventEmitter(), { end: vi.fn() });
    const spy = vi.spyOn(https, 'request').mockImplementation(((options: never) => {
      void options;
      return request;
    }) as never);
    const signal = new AbortController().signal;
    void remoteImageTransport.fetch('https://images.example.test:8443/a/b.png?x=1', {
      signal,
      pinned: [
        { address: V4, family: 4 },
        { address: V6, family: 6 }
      ]
    });
    const options = spy.mock.calls[0][0] as unknown as {
      host: string;
      port: number;
      path: string;
      servername: string;
      agent: unknown;
      signal: AbortSignal;
      lookup: (host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void;
    };
    expect(options).toMatchObject({ host: 'images.example.test', port: 8443, path: '/a/b.png?x=1', servername: 'images.example.test', agent: false });
    expect(options.signal).toBe(signal);
    const one = vi.fn();
    options.lookup('images.example.test', {}, one);
    expect(one).toHaveBeenCalledWith(null, V4, 4);
    const all = vi.fn();
    options.lookup('images.example.test', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [
      { address: V4, family: 4 },
      { address: V6, family: 6 }
    ]);
    expect(request.end).toHaveBeenCalled();
  });

  it('refuses to connect with nothing pinned', async () => {
    const spy = vi.spyOn(https, 'request');
    await expect(remoteImageTransport.fetch('https://images.example.test/a.png', { signal: new AbortController().signal, pinned: [] })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('checks a URL and pins a literal address without asking DNS', async () => {
    await expect(
      imageServiceTesting.validateRemoteImageUrl(`https://[${V6}]/a.png`, new AbortController().signal)
    ).resolves.toMatchObject({ pinned: [{ address: V6, family: 6 }] });
    await expect(
      imageServiceTesting.validateRemoteImageUrl('https://[64:ff9b::7f00:1]/a.png', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });
});

describe('a refused download lets its connection go (#730)', () => {
  const original = remoteImageTransport.fetch;
  afterEach(() => {
    remoteImageTransport.fetch = original;
  });

  it.each([
    ['a refused type', 200, { 'content-type': 'text/html' }],
    ['a size over the cap', 200, { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) }],
    ['an error status', 404, { 'content-type': 'image/png' }]
  ])('ends the request after %s, its body unread', async (_label, status, headers) => {
    let seen: AbortSignal | undefined;
    remoteImageTransport.fetch = async (_url, init) => {
      seen = init.signal;
      return new Response(new ReadableStream({ start() {} }), { status, headers });
    };
    await expect(imageServiceTesting.downloadImage('https://93.184.216.34/a.png', {})).rejects.toBeTruthy();
    expect(seen?.aborted).toBe(true);
  });
});
