import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  buildCapabilities,
  handleCapabilitiesRequest,
  type CapabilitiesDocument,
  type PayAndSendPrice
} from '../../../src/api/capabilitiesApi.js';
import {
  getConfiguredProducts,
  JIT_PRODUCTS,
  jitProductFor,
  jitProductMatching,
  PACK_PRODUCTS,
  type MailOption
} from '../../../src/config/products.js';
import type { PostcardSize } from '../../../src/services/types.js';

const URLS = { mcpServer: 'https://api.example.test/mcp' };

const ALL_OFF: NodeJS.ProcessEnv = {};
const PAY_AND_SEND: NodeJS.ProcessEnv = { JIT_PURCHASE_ENABLED: 'true' };
const EVERY_OPTION: NodeJS.ProcessEnv = {
  JIT_PURCHASE_ENABLED: 'true',
  LETTER_IRL_PRINT_RENDERER: 'pdf',
  LETTER_IRL_ROOM_TO_WRITE_ENABLED: 'true',
  LETTER_IRL_POSTCARD_SIZES_ENABLED: 'true',
  LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'true',
  LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: 'true',
  LETTER_IRL_POSTCARD_COLLAGES_ENABLED: 'true',
  LETTER_IRL_STATIONERY_ENABLED: 'true',
  LETTER_IRL_CUSTOM_STATIONERY_ENABLED: 'true',
  LETTER_IRL_SIGNATURES_ENABLED: 'true',
  LETTER_IRL_ARRIVE_BY_ENABLED: 'true',
  LETTER_IRL_ADDRESS_REQUESTS_ENABLED: 'true',
  LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'true'
};
// The options' flags on, but our renderer off: the previews offer none of the
// renderer's options, so none of their prices may be listed.
const FLAGS_WITHOUT_RENDERER: NodeJS.ProcessEnv = { ...EVERY_OPTION, LETTER_IRL_PRINT_RENDERER: 'html' };

const ENVS: Record<string, NodeJS.ProcessEnv> = {
  'all off': ALL_OFF,
  'Pay & Send only': PAY_AND_SEND,
  'every option': EVERY_OPTION,
  'flags without the renderer': FLAGS_WITHOUT_RENDERER
};

const SIZE_BY_NAME: Record<string, PostcardSize> = { '6x9': '6x9', '4x6': '6x4', '11x6': '6x11' };

/** The mail option a listed price is for, as the product table reads one. */
function optionOf(row: PayAndSendPrice): MailOption {
  if (row.mailType === 'postcard') {
    const size = SIZE_BY_NAME[row.size ?? ''];
    expect(size, `a postcard row names a known size: ${row.size}`).toBeDefined();
    return { mailType: 'postcard', postcardSize: size };
  }
  return {
    mailType: 'letter',
    ...(row.pages === undefined ? {} : { pages: row.pages }),
    ...(row.mailService === undefined || row.mailService === 'standard' ? {} : { mailService: row.mailService })
  };
}

function payAndSendRows(doc: CapabilitiesDocument): readonly PayAndSendPrice[] {
  return doc.pricing.payAndSend?.items ?? [];
}

describe('GET /capabilities.json agrees with the product table (#630)', () => {
  it.each(Object.entries(ENVS))('lists every pack at its pinned amount (%s)', (_name, env) => {
    const doc = buildCapabilities(env, URLS);
    expect(doc.pricing.packs.items.map(pack => [pack.letters, pack.price.amountMinor, pack.price.currency])).toEqual(
      PACK_PRODUCTS.map(product => [product.letters, product.expectedAmountCents, 'usd'])
    );
    expect(doc.pricing.packs.items.map(pack => pack.name)).toEqual(PACK_PRODUCTS.map(product => product.name));
  });

  it.each(Object.entries(ENVS))('prices every Pay & Send row as the product table does, and only what is sold (%s)', (_name, env) => {
    const configured = new Set(getConfiguredProducts(env).map(row => row.productCode));
    for (const row of payAndSendRows(buildCapabilities(env, URLS))) {
      const option = optionOf(row);
      const product = jitProductFor(option, env);
      expect(product, `${row.description} is sold here`).not.toBeNull();
      expect(row.price.amountMinor).toBe(product!.expectedAmountCents);
      expect(row.price.currency).toBe('usd');
      expect(configured.has(product!.productCode)).toBe(true);
    }
  });

  it('lists every Pay & Send product, once each, when every option is offered', () => {
    const rows = payAndSendRows(buildCapabilities(EVERY_OPTION, URLS));
    const codes = rows.map(row => jitProductMatching(optionOf(row))?.productCode);
    expect([...codes].sort()).toEqual(JIT_PRODUCTS.map(product => product.productCode).sort());
  });

  it('with Pay & Send alone, lists only the one-page letter and the 6x9 postcard', () => {
    const rows = payAndSendRows(buildCapabilities(PAY_AND_SEND, URLS));
    expect(rows.map(row => jitProductMatching(optionOf(row))?.productCode)).toEqual(['jit-letter', 'jit-postcard']);
  });

  it("lists no option price whose option the previews do not offer (flags on, the renderer's off)", () => {
    const rows = payAndSendRows(buildCapabilities(FLAGS_WITHOUT_RENDERER, URLS));
    // Certified mail needs no renderer; the pages and the sizes do.
    expect(rows.map(row => jitProductMatching(optionOf(row))?.productCode).sort()).toEqual(
      ['jit-letter', 'jit-letter-certified', 'jit-letter-certified-receipt', 'jit-postcard'].sort()
    );
    // And a certified letter is then one page, as every letter is.
    expect(rows.find(row => row.mailService === 'certified')?.description).toBe('One one-page letter, sent as USPS Certified Mail');
    expect(payAndSendRows(buildCapabilities(EVERY_OPTION, URLS)).find(row => row.mailService === 'certified')?.description).toBe(
      'One letter of one to 3 pages, sent as USPS Certified Mail'
    );
  });

  it('formats the amounts for display', () => {
    const doc = buildCapabilities(EVERY_OPTION, URLS);
    expect(doc.pricing.packs.items[0].price.display).toBe('5.00');
    expect(payAndSendRows(doc)[0].price.display).toBe('4.99');
    const yen = buildCapabilities({ ...EVERY_OPTION, STRIPE_CURRENCY: 'jpy' }, URLS);
    expect(yen.pricing.packs.items[0].price).toEqual({ amountMinor: 500, currency: 'jpy', display: '500' });
  });
});

describe('GET /capabilities.json shows only what this deployment offers', () => {
  it('with everything off: packs, the two mail kinds, standard delivery', () => {
    const doc = buildCapabilities(ALL_OFF, URLS);
    expect(doc.pricing.payAndSend).toBeUndefined();
    expect(doc.delivery.certified).toBeUndefined();
    expect(doc.delivery.arriveBy).toBeUndefined();
    expect(doc.mail.map(kind => kind.kind)).toEqual(['letter', 'postcard']);
    expect(doc.mail[1].options).toEqual([]);
    const text = JSON.stringify(doc);
    for (const word of ['ertified', '4x6', '11x6', 'Stationery', 'Signature', 'Collage', 'layout', 'arrive by', 'Address requests']) {
      expect(text, word).not.toContain(word);
    }
  });

  it('with every option on, names each one', () => {
    const doc = buildCapabilities(EVERY_OPTION, URLS);
    expect(doc.mail[0].options.map(option => option.name)).toEqual([
      'Image', 'More pages', 'Stationery', 'Saved stationery designs', 'Signature', 'Certified mail'
    ]);
    expect(doc.mail[1].options.map(option => option.name)).toEqual(['Size', 'Front layout', 'Collage']);
    expect(doc.delivery.certified?.mailClasses).toHaveLength(2);
    expect(doc.delivery.arriveBy).toEqual(expect.objectContaining({ maxDaysAhead: 60, leadBusinessDays: 7 }));
    expect(doc.limits.find(limit => limit.name === 'Letter length')?.value).toBe(3);
    expect(doc.limits.find(limit => limit.name === 'Address requests')?.value).toBe(7);
  });

  it('says who sends, by the send rule', () => {
    expect(buildCapabilities(EVERY_OPTION, URLS).sending.whoSends).toMatch(/^A person sends each piece of mail\./);
    expect(buildCapabilities(ALL_OFF, URLS).sending.whoSends).toMatch(/only after the person has checked its preview/);
  });

  it('names no product code, price id, setting or secret', () => {
    const env: NodeJS.ProcessEnv = {
      ...EVERY_OPTION,
      STRIPE_SECRET_KEY: 'sk_test_capabilities_secret',
      STRIPE_PRICE_STARTER: 'price_capabilities_starter',
      STRIPE_JIT_LETTER_PRICE_ID: 'price_capabilities_letter'
    };
    const text = JSON.stringify(buildCapabilities(env, URLS));
    const forbidden = [
      'sk_test', 'price_', 'STRIPE', 'LETTER_IRL_', 'ENABLED', 'credit',
      ...PACK_PRODUCTS.flatMap(product => [product.productCode, product.priceEnv]),
      ...JIT_PRODUCTS.flatMap(product => [product.productCode, product.priceEnv])
    ];
    for (const value of forbidden) expect(text, value).not.toContain(value);
  });

  it('uses no promotional or comparative words, and promises no delivery date', () => {
    const text = JSON.stringify(buildCapabilities(EVERY_OPTION, URLS)).toLowerCase();
    for (const word of ['best', 'cheapest', 'fastest', 'official', 'leading', 'better than', 'guaranteed delivery', 'guaranteed to arrive', 'will arrive']) {
      expect(text, word).not.toContain(word);
    }
  });
});

interface FakeResponse {
  status?: number;
  headers: Record<string, string | number>;
  body?: string;
}

function call(method: string): FakeResponse {
  const result: FakeResponse = { headers: {} };
  const res = {
    writeHead(status: number, headers: Record<string, string | number>) {
      result.status = status;
      result.headers = headers;
      return this;
    },
    end(body?: string) {
      result.body = body;
      return this;
    }
  } as unknown as ServerResponse;
  handleCapabilitiesRequest({ method } as IncomingMessage, res, URLS, EVERY_OPTION);
  return result;
}

describe('handleCapabilitiesRequest', () => {
  it('answers GET with the document, cacheable', () => {
    const answer = call('GET');
    expect(answer.status).toBe(200);
    expect(answer.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(answer.headers['Cache-Control']).toBe('public, max-age=300');
    expect(JSON.parse(answer.body!)).toEqual(buildCapabilities(EVERY_OPTION, URLS));
    expect(answer.headers['Content-Length']).toBe(Buffer.byteLength(answer.body!));
  });

  it('answers HEAD with the headers alone', () => {
    const answer = call('HEAD');
    expect(answer.status).toBe(200);
    expect(answer.body).toBeUndefined();
  });

  it('refuses other methods', () => {
    const answer = call('POST');
    expect(answer.status).toBe(405);
    expect(answer.headers.Allow).toBe('GET, HEAD');
  });
});
