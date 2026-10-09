import {
  FEED_MAX_ATTEMPTS, FEED_MAX_BYTES, FEED_MAX_OFFERS, FEED_TIMEOUT_MS,
  loadProfitbaseOffers, parseValidatedProfitbaseOffers, retryDelayMs,
  validateProfitbaseFeedUrl,
} from './profitbase-feed';

const URL = 'https://pb7828.profitbase.ru/export/profitbase_xml/' + 'a'.repeat(32) + '?scheme=https';
const OFFER = '<offer internal-id="1"><number>101</number><status>AVAILABLE</status><object><name>Зорге 9</name></object><area><value>50</value></area><price><value>20000000</value></price></offer>';
const XML = '<?xml version="1.0" encoding="UTF-8"?><realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06"><generation-date>2026-10-09T01:00:00+03:00</generation-date>' + OFFER + '</realty-feed>';
function response(text = XML, status = 200, headers: Record<string, string> = {}) {
  const bytes = Buffer.from(text);
  let finished = false;
  const reader = { read: jest.fn(async () => { if (finished) return { done: true }; finished = true; return { done: false, value: bytes }; }), cancel: jest.fn(async () => {}), releaseLock: jest.fn() };
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { status, ok: status >= 200 && status < 300, redirected: false, url: URL,
    headers: { get: (name: string) => normalized[name.toLowerCase()] ?? null },
    body: { getReader: () => reader, cancel: jest.fn(async () => {}) }, reader } as any;
}
describe('ProfitBase safe GET-only feed loading', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
  it('accepts only the exact HTTPS account export URL', () => {
    expect(validateProfitbaseFeedUrl(URL)).toBe(URL);
  });
  it.each([
    URL.replace('https:', 'http:'), URL.replace('pb7828.profitbase.ru', 'localhost'), URL.replace('pb7828.profitbase.ru', 'pb7828.profitbase.ru.evil.test'),
    URL.replace('https://', 'https://user:private@'), URL.replace('pb7828.profitbase.ru', '127.0.0.1'), URL + '#fragment', URL + '&url=http://localhost', URL + '\n', URL.replace('?scheme=https', '?scheme=http'), URL.replace('/export/', '/other/'),
  ])('rejects unsafe configuration before a network request', async (url) => {
    const fetchImpl = jest.fn();
    await expect(loadProfitbaseOffers(url, { fetchImpl })).rejects.toMatchObject({ code: 'FEED_URL_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('never permits disabled TLS verification', async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const fetchImpl = jest.fn();
    try { await expect(loadProfitbaseOffers(URL, { fetchImpl })).rejects.toMatchObject({ code: 'FEED_TLS_CONFIGURATION_INVALID' }); expect(fetchImpl).not.toHaveBeenCalled(); }
    finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; }
  });
  it('uses GET, strict redirect rejection and an abort signal, preserves parser attributes/arrays/entities', async () => {
    const fetchImpl = jest.fn(async () => response(XML.replace('</offer>', '<image type="plan">https://images.example.test/a?a=1&amp;b=2</image></offer>')));
    const offers = await loadProfitbaseOffers(URL, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(URL, expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(offers[0]['@_internal-id']).toBe('1'); expect(offers[0].image).toEqual([{ '#text': 'https://images.example.test/a?a=1&b=2', '@_type': 'plan' }]);
  });
  it('recovers from transient HTTP500 then writes no data itself', async () => {
    const rejected = response('private-provider-error', 500, { 'retry-after': '2' });
    const fetchImpl = jest.fn().mockResolvedValueOnce(rejected).mockResolvedValueOnce(response());
    const wait = jest.fn(async () => {});
    expect(await loadProfitbaseOffers(URL, { fetchImpl, wait })).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(wait).toHaveBeenCalledWith(2000);
    expect(rejected.body.cancel).toHaveBeenCalledTimes(1);
  });
  it.each([408, 429, 500, 502, 503, 504])('limits persistent transient HTTP%s to three GET attempts, retains a failure', async (status) => {
    const fetchImpl = jest.fn(async () => response('private-body-and-token', status)); const wait = jest.fn(async () => {});
    await expect(loadProfitbaseOffers(URL, { fetchImpl, wait })).rejects.toMatchObject({ code: 'FEED_HTTP_ERROR', httpStatus: status, message: `Feed fetch failed: ${status}` });
    expect(fetchImpl).toHaveBeenCalledTimes(FEED_MAX_ATTEMPTS); expect(wait.mock.calls).toEqual([[1000], [2000]]);
  });
  it.each([301, 302, 400, 401, 403, 404])('does not retry permanent/redirect HTTP%s', async (status) => {
    const fetchImpl = jest.fn(async () => response('private-error', status)); const wait = jest.fn(async () => {});
    await expect(loadProfitbaseOffers(URL, { fetchImpl, wait })).rejects.toMatchObject({ code: 'FEED_HTTP_ERROR', httpStatus: status });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
  });
  it('sanitizes raw network errors, never emits export URL or upstream body', async () => {
    const fetchImpl = jest.fn(async () => { throw Error('private credentials ' + URL); }); const wait = jest.fn(async () => {});
    try { await loadProfitbaseOffers(URL, { fetchImpl, wait }); throw Error('Unexpected success'); }
    catch (error: any) { expect(error.code).toBe('FEED_NETWORK_ERROR'); expect(error.message).not.toMatch(/private|https|credentials/); }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('honors both numeric and HTTP-date Retry-After without retrying early beyond the bound', async () => {
    const now = Date.parse('2026-10-09T00:00:00Z');
    expect(retryDelayMs('3', 1, now)).toBe(3000);
    expect(retryDelayMs('Fri, 09 Oct 2026 00:00:04 GMT', 1, now)).toBe(4000);
    expect(retryDelayMs('Friday, 09-Oct-26 00:00:04 GMT', 1, now)).toBe(4000);
    expect(retryDelayMs('Fri Oct  9 00:00:04 2026', 1, now)).toBe(4000);
    expect(retryDelayMs('Fri, 09 Oct 2026 00:00:00 GMT', 1, now)).toBe(0);
    expect(retryDelayMs('invalid', 2, now)).toBe(2000);
    expect(retryDelayMs('1.5', 2, now)).toBe(2000);
    expect(retryDelayMs('-1', 2, now)).toBe(2000);
    const fetchImpl = jest.fn(async () => response('private', 503, { 'Retry-After': '60' })); const wait = jest.fn(async () => {});
    await expect(loadProfitbaseOffers(URL, { fetchImpl, wait })).rejects.toMatchObject({ code: 'FEED_RETRY_AFTER_LIMIT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
  });
  it.each(['1000000', '9'.repeat(400)])('does not discard a large valid delay-seconds instruction', async (value) => {
    expect(() => retryDelayMs(value, 1)).toThrow('FEED_RETRY_AFTER_LIMIT');
    const fetchImpl = jest.fn(async () => response('private', 503, { 'retry-after': value })); const wait = jest.fn(async () => {});
    await expect(loadProfitbaseOffers(URL, { fetchImpl, wait })).rejects.toMatchObject({ code: 'FEED_RETRY_AFTER_LIMIT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
  });
  it('enforces the whole fetch deadline even when a provider ignores AbortSignal', async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl = jest.fn(async (_url, options) => { signals.push(options.signal); return await new Promise(() => {}); });
    const pending = loadProfitbaseOffers(URL, { fetchImpl: fetchImpl as any, wait: async () => {} });
    const failure = expect(pending).rejects.toMatchObject({ code: 'FEED_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(FEED_TIMEOUT_MS * FEED_MAX_ATTEMPTS); await failure;
    expect(fetchImpl).toHaveBeenCalledTimes(3); expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('enforces the same deadline across a stalled response body', async () => {
    jest.useFakeTimers();
    const read = jest.fn(async () => await new Promise(() => {})), cancel = jest.fn(async () => {});
    const fetchImpl = jest.fn(async () => ({ ...response(), body: { getReader: () => ({ read, cancel, releaseLock: jest.fn() }) } }));
    const pending = loadProfitbaseOffers(URL, { fetchImpl: fetchImpl as any, wait: async () => {} });
    const failure = expect(pending).rejects.toMatchObject({ code: 'FEED_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(FEED_TIMEOUT_MS * FEED_MAX_ATTEMPTS); await failure;
    expect(fetchImpl).toHaveBeenCalledTimes(3); expect(cancel).toHaveBeenCalledTimes(3);
  });
  it('bounds declared and streamed/decompressed response bytes before parsing', async () => {
    const declared = response(XML, 200, { 'content-length': String(FEED_MAX_BYTES + 1) });
    const streamed = response(); streamed.reader.read.mockResolvedValueOnce({ done: false, value: Buffer.alloc(FEED_MAX_BYTES + 1) });
    for (const current of [declared, streamed]) {
      const fetchImpl = jest.fn(async () => current);
      await expect(loadProfitbaseOffers(URL, { fetchImpl })).rejects.toMatchObject({ code: 'FEED_BODY_TOO_LARGE' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    expect(declared.reader.read).not.toHaveBeenCalled(); expect(streamed.reader.cancel).toHaveBeenCalledTimes(1);
  });
  it('rejects a truncated declared body and does not compare compressed length to decoded bytes', async () => {
    const fetchImpl = jest.fn(async () => response(XML, 200, { 'content-length': '999999' }));
    await expect(loadProfitbaseOffers(URL, { fetchImpl, wait: async () => {} })).rejects.toMatchObject({ code: 'FEED_BODY_INCOMPLETE' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const compressed = jest.fn(async () => response(XML, 200, { 'content-length': '12', 'content-encoding': 'gzip' }));
    expect(await loadProfitbaseOffers(URL, { fetchImpl: compressed })).toHaveLength(1);
  });
  it('rejects HTML, invalid UTF8 and redirected response metadata without parsing or retry', async () => {
    const html = response('<html>private</html>', 200, { 'content-type': 'text/html; charset=utf-8' });
    const utf8 = response(); utf8.reader.read.mockResolvedValueOnce({ done: false, value: Buffer.from([0xff]) });
    const redirected = { ...response(), redirected: true, url: 'http://localhost/private' };
    for (const current of [html, utf8, redirected]) {
      const fetchImpl = jest.fn(async () => current);
      await expect(loadProfitbaseOffers(URL, { fetchImpl })).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    expect(html.reader.read).not.toHaveBeenCalled();
  });
  it.each([
    '', '<html><body>private</body></html>', '<realty-feed/>', '<realty-feed></realty-feed>',
    '<realty-feed>' + OFFER, '<realty-feed>' + OFFER + '<offer internal-id="2">',
    '<!DOCTYPE realty-feed [<!ENTITY x SYSTEM "file:///private">]><realty-feed>' + OFFER + '</realty-feed>',
    '<realty-feed>' + OFFER + OFFER + '</realty-feed>',
    '<realty-feed><offer><number>1</number></offer></realty-feed>',
    '<realty-feed>' + OFFER.replace('20000000', 'NaN') + '</realty-feed>',
    '<realty-feed>' + OFFER.replace('<value>50</value>', '<value><nested>50</nested></value>') + '</realty-feed>',
    '<realty-feed>' + OFFER.replace('<status>AVAILABLE</status>', '<status>1</status>') + '</realty-feed>',
  ])('rejects unsafe, empty, malformed or duplicate XML before any catalog mutation', async (xml) => {
    const fetchImpl = jest.fn(async () => response(xml));
    await expect(loadProfitbaseOffers(URL, { fetchImpl })).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('bounds offer count and tag nesting', () => {
    const tooMany = '<realty-feed>' + Array.from({ length: FEED_MAX_OFFERS + 1 }, (_, i) => `<offer internal-id="${i}"/>`).join('') + '</realty-feed>';
    expect(() => parseValidatedProfitbaseOffers(tooMany)).toThrow();
    const nested = '<realty-feed>' + OFFER.replace('</offer>', '<n>'.repeat(70) + '</n>'.repeat(70) + '</offer>') + '</realty-feed>';
    expect(() => parseValidatedProfitbaseOffers(nested)).toThrow();
  });
  it('accepts representable Int32 and NUMERIC boundary values, including safe database rounding', () => {
    const extra = '<floor>-2147483648</floor><house><floors-total>2147483647</floors-total></house><price-meter><value>99999999.994</value></price-meter><special-offers><special-offer><discount-price>999999999999.99</discount-price><discount-unit>PERCENT</discount-unit><value>999.994</value></special-offer></special-offers>';
    const xml = '<realty-feed>' + OFFER.replace('<value>50</value>', '<value>99999999.99</value>').replace('20000000', '999999999999.99').replace('</offer>', extra + '</offer>') + '</realty-feed>';
    expect(parseValidatedProfitbaseOffers(xml)).toHaveLength(1);
  });
});
