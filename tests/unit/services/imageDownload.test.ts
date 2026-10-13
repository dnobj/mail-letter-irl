import https from 'node:https';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ipv6Groups,
  isUnsafeIpAddress,
  isUnsafeIpv6Address,
  remoteImageTransport,
  resolvePublicAddress,
  type ImageHostResolver
} from '../../../src/services/imageDownload.js';
import { _testing as imageServiceTesting } from '../../../src/services/imageService.js';

/** A resolver that answers from a table, or never. */
function resolverOf(four: string[] | 'hang', six: string[] = []) {
  const cancel = vi.fn();
  let rejectHang: ((error: Error) => void) | undefined;
  const resolver: ImageHostResolver = {
    resolve4: () =>
      four === 'hang'
        ? new Promise<string[]>((_resolve, reject) => {
            rejectHang = reject;
          })
        : Promise.resolve(four),
    resolve6: () => (six.length ? Promise.resolve(six) : Promise.reject(Object.assign(new Error('none'), { code: 'ENODATA' }))),
    cancel: () => {
      cancel();
      rejectHang?.(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
    }
  };
  return { resolver, cancel };
}

describe('image hosts resolve off the thread pool, every address checked (#730)', () => {
  const live = () => new AbortController().signal;

  it('connects to a public IPv4 address when there is one', async () => {
    const { resolver } = resolverOf(['93.184.216.34'], ['2606:2800:220:1:248:1893:25c8:1946']);
    await expect(resolvePublicAddress('example.test', live(), () => resolver)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4
    });
  });

  it('takes IPv6 when the host has only that', async () => {
    const { resolver } = resolverOf([], ['2606:2800:220:1:248:1893:25c8:1946']);
    await expect(resolvePublicAddress('example.test', live(), () => resolver)).resolves.toEqual({
      address: '2606:2800:220:1:248:1893:25c8:1946',
      family: 6
    });
  });

  it.each([
    ['a private address', ['10.0.0.5'], []],
    ['one private address among public ones', ['93.184.216.34', '127.0.0.1'], []],
    ['a NAT64 address beside a public one', ['93.184.216.34'], ['64:ff9b::7f00:1']],
    ['no address', [], []]
  ])('refuses a host with %s', async (_label, four, six) => {
    const { resolver } = resolverOf(four, six);
    await expect(resolvePublicAddress('example.test', live(), () => resolver)).resolves.toBeNull();
  });

  it('gives up when the deadline passes, cancelling the queries', async () => {
    const { resolver, cancel } = resolverOf('hang');
    const controller = new AbortController();
    const pending = resolvePublicAddress('slow.test', controller.signal, () => resolver);
    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it('drops an answer that arrives after the deadline', async () => {
    let answer: (addresses: string[]) => void = () => undefined;
    const resolver: ImageHostResolver = {
      resolve4: () => new Promise<string[]>(resolve => {
        answer = resolve;
      }),
      resolve6: () => Promise.resolve([]),
      cancel: () => undefined
    };
    const controller = new AbortController();
    const pending = resolvePublicAddress('late.test', controller.signal, () => resolver);
    controller.abort();
    answer(['93.184.216.34']);
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
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '::a00:1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1',
    '2001:db8::1', '3fff::1', '64:ff9b::7f00:1', '64:ff9b:1::a00:1', '2002:7f00:1::1',
    '2001::1', '2001:0:4136:e378::1', '100::1', '100:0:0:0:ffff::1', '5f00::1',
    'not-an-address:::'
  ])('%s is refused', address => {
    expect(isUnsafeIpAddress(address) || ipv6Groups(address) === null).toBe(true);
  });

  it('refuses what it cannot read as an IPv6 address', () => {
    for (const text of ['1::2::3', 'zzzz::1', '1:2:3']) expect(isUnsafeIpv6Address(text), text).toBe(true);
  });

  it.each(['2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4009:81f::200e', '2001:4860:4860::8888', '100:1::1'])(
    '%s is public',
    address => {
      expect(isUnsafeIpAddress(address)).toBe(false);
    }
  );

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

describe('the connection goes to the address that was checked (#730)', () => {
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
      pinned: { address: '93.184.216.34', family: 4 }
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
    expect(one).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const all = vi.fn();
    options.lookup('images.example.test', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    expect(request.end).toHaveBeenCalled();
  });

  it('checks a URL and pins a literal address without asking DNS', async () => {
    await expect(
      imageServiceTesting.validateRemoteImageUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/a.png', new AbortController().signal)
    ).resolves.toMatchObject({ pinned: { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 } });
    await expect(
      imageServiceTesting.validateRemoteImageUrl('https://[64:ff9b::7f00:1]/a.png', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });
});
