// The LNURL-pay cases of Sovereigncast's tests/test_v4v_boost_split.py, plus
// the amount check and the SSRF guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lnurlInvoice, appendQuery, lnurlPayerData, isPublicHttpsUrl } from '../src/lnurl.ts';
import { decodeBolt11 } from '../src/bolt11.ts';
import { fakeInvoice, stubFetch } from './helpers.ts';

const LNURLP = { callback: 'https://x.invalid/cb', minSendable: 1000, maxSendable: 100_000_000, commentAllowed: 200 };
const INV100 = fakeInvoice(100);
const ok = async () => true; // stands the SSRF guard down, as Sovereigncast's public_urls fixture does

function run(s: ReturnType<typeof stubFetch>, o: { address?: string; sats?: number; comment?: string; sender?: string; guard?: boolean } = {}) {
  return lnurlInvoice(o.address ?? 'sat@x.invalid', o.sats ?? 100, o.comment ?? '⚡ Boost #1 Test',
    o.sender ?? 'Nodesignal Community', { fetch: s.fetch, isSafeUrl: o.guard ? undefined : ok });
}

test('an invoice is fetched for the recipient\'s own share (msats, with the comment)', async () => {
  const s = stubFetch(LNURLP, { pr: INV100 });
  const r = await run(s);
  assert.deepEqual([r.invoice, r.error, r.memoCarried], [INV100, undefined, true]);
  assert.match(s.urls[1], /amount=100000/);
  assert.match(s.urls[1], /comment=/);
});

test('a share below the provider\'s minimum is reported, not rounded up', async () => {
  const r = await run(stubFetch({ ...LNURLP, minSendable: 10_000_000 }, { pr: INV100 }));
  assert.equal(r.invoice, undefined);
  assert.match(r.error!, /minimum/);
});

test('a share above the maximum is reported', async () => {
  const r = await run(stubFetch({ ...LNURLP, maxSendable: 10_000 }, { pr: INV100 }));
  assert.equal(r.invoice, undefined);
  assert.match(r.error!, /maximum/);
});

test('a provider taking no comment still gets paid but reports no memo', async () => {
  const s = stubFetch({ ...LNURLP, commentAllowed: 0 }, { pr: INV100 });
  const r = await run(s);
  assert.deepEqual([r.invoice, r.error, r.memoCarried], [INV100, undefined, false]);
  assert.doesNotMatch(s.urls[1], /comment=/);
});

test('the comment is cut to commentAllowed (code points)', async () => {
  const s = stubFetch({ ...LNURLP, commentAllowed: 3 }, { pr: INV100 });
  await run(s, { comment: '⚡ab cdef' });
  assert.match(s.urls[1], /comment=%E2%9A%A1ab(&|$)/);
});

test('a provider error is an error, not an exception', async () => {
  const r = await run(stubFetch({ status: 'ERROR', reason: 'unknown user' }, { pr: INV100 }));
  assert.equal(r.invoice, undefined);
  assert.equal(r.error, 'unknown user');
});

test('a callback that returns no invoice is an error', async () => {
  const r = await run(stubFetch(LNURLP, { pr: '' }));
  assert.equal(r.invoice, undefined);
  assert.ok(r.error);
});

test('an invoice for another amount than the share is refused (Hopp M-04/M-06)', async () => {
  const r = await run(stubFetch(LNURLP, { pr: fakeInvoice(101) }));
  assert.equal(r.invoice, undefined);
  assert.match(r.error!, /is not the share/);
  const amountless = await run(stubFetch(LNURLP, { pr: 'lnbc1test' }));
  assert.match(amountless.error!, /unreadable invoice/);
});

test('an address without a domain never reaches the network', async () => {
  const s = stubFetch(LNURLP, { pr: INV100 });
  const r = await run(s, { address: 'nope' });
  assert.equal(r.error, 'invalid address');
  assert.deepEqual(s.urls, []);
});

test('a host that does not resolve publicly is never contacted', async () => {
  const s = stubFetch(LNURLP, { pr: INV100 });
  const r = await run(s, { guard: true });
  assert.equal(r.error, 'not a public address');
  assert.deepEqual(s.urls, []);
});

test('the SSRF guard: https and public addresses only', async () => {
  assert.equal(await isPublicHttpsUrl('http://1.1.1.1/x'), false);
  assert.equal(await isPublicHttpsUrl('https://127.0.0.1/x'), false);
  assert.equal(await isPublicHttpsUrl('https://10.1.2.3/x'), false);
  assert.equal(await isPublicHttpsUrl('https://[::1]/x'), false);
  assert.equal(await isPublicHttpsUrl('https://169.254.169.254/latest'), false);
  assert.equal(await isPublicHttpsUrl('https://1.1.1.1/x'), true);
});

test('a callback that already has a query string gets an ampersand', () => {
  assert.equal(appendQuery('https://x.invalid/cb?id=abc', { amount: 1000 }), 'https://x.invalid/cb?id=abc&amount=1000');
});

test('a plain callback gets a question mark', () => {
  assert.equal(appendQuery('https://x.invalid/cb', { amount: 1000 }), 'https://x.invalid/cb?amount=1000');
});

test('the comment is urlencoded, not pasted in raw', () => {
  const url = appendQuery('https://x.invalid/cb', { amount: 1000, comment: '⚡ Boost #1 & co' });
  assert.equal(url, 'https://x.invalid/cb?amount=1000&comment=%E2%9A%A1+Boost+%231+%26+co');
  assert.equal(url.split('&').length - 1, 1);
});

for (const callback of ['https://x.invalid/cb?id=abc', 'https://x.invalid/cb']) {
  test(`the amount survives the callback shape ${callback}`, async () => {
    const s = stubFetch({ ...LNURLP, callback }, { pr: INV100 });
    const r = await run(s);
    assert.equal(r.invoice, INV100);
    assert.match(s.urls[1], /amount=100000/);
  });
}

test('LUD-18: payer data is sent when the provider asks for a name', () => {
  assert.equal(lnurlPayerData({ payerData: { name: { mandatory: false } } }, 'Nodesignal Community'), '{"name":"Nodesignal Community"}');
});

test('LUD-18: no payer data when the provider does not declare any', () => {
  assert.equal(lnurlPayerData({}, 'Nodesignal Community'), undefined);
});

test('LUD-18: no payer data when auth is mandatory', () => {
  assert.equal(lnurlPayerData({ payerData: { name: { mandatory: false }, auth: { mandatory: true, k1: 'x' } } }, 'N'), undefined);
});

test('LUD-18: no payer data when a field we will not supply is mandatory', () => {
  assert.equal(lnurlPayerData({ payerData: { name: { mandatory: false }, email: { mandatory: true } } }, 'N'), undefined);
});

test('LUD-18: an optional field we skip does not block the name', () => {
  assert.equal(lnurlPayerData({ payerData: { name: { mandatory: false }, pubkey: { mandatory: false } } }, 'Nodesignal Community'),
    '{"name":"Nodesignal Community"}');
});

test('LUD-18: payer data reaches the callback but does not count as a memo', async () => {
  const s = stubFetch({ ...LNURLP, commentAllowed: 0, payerData: { name: { mandatory: false } } }, { pr: INV100 });
  const r = await run(s);
  assert.equal(r.invoice, INV100);
  assert.match(s.urls[1], /payerdata=/);
  assert.equal(r.memoCarried, false);
});

test('bolt11: the BOLT 11 spec example and a testnut invoice decode', () => {
  const spec = decodeBolt11('lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh');
  assert.equal(spec.amountMsat, 250_000_000);
  assert.equal(spec.paymentHash, '0001020304050607080900010203040506070809000102030405060708090102');
  assert.equal(spec.description, '1 cup coffee');
  const tn = decodeBolt11('lnbc2100n1p4wax6ddq4de6hgumsd35hggr5v4ehgpp5r5al2hluglrsm7zlnrgd6sezc38rct5dtkcqmmn9vlpzs7f7q3hssp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzys9gcwyhv3swvknj8x94xxtn9kt57wfqv00655p67y8wa0y84my8e9zs2d50lyvhqazzknn7ed44xdlese6yjdgralfm0d6we27q8hgcsq3kfugj');
  assert.equal(tn.amountMsat, 210_000);
  assert.equal(tn.description, 'nutsplit test');
  assert.equal(decodeBolt11(fakeInvoice(17)).amountMsat, 17_000);
});
