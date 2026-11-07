// The HTTP surface, end to end over a real socket, with the in-memory mint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Ledger } from '../src/ledger.ts';
import { parseFeed } from '../src/feed.ts';
import { createNutsplitServer } from '../src/server.ts';
import { decodeFeedRequest } from '../src/creq.ts';
import { paymentUrl } from '../src/listener.ts';
import { FakeMint } from './fake-mint.ts';
import type { Show } from '../src/accrue.ts';

const feed = parseFeed(gunzipSync(readFileSync(new URL('./fixtures/nodesignal-feed.xml.gz', import.meta.url))).toString('utf8'));
const GUID = feed.podcastGuid!;
const E301 = '7d3a1f3d-c709-4eaa-8f8b-2260330ee403';

async function start(rateLimitPerMin = 0) {
  const ledger = new Ledger();
  const mint = new FakeMint();
  const show: Show = { podcastGuid: GUID, feed, feePolicy: 'show' };
  const server = createNutsplitServer({ ledger, shows: [show], mints: [mint], rateLimitPerMin });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { ledger, mint, base, close: () => new Promise((r) => server.close(r)) };
}

const payload = (mint: string, sats: number, memo?: string) =>
  JSON.stringify({ mint, unit: 'sat', memo, proofs: FakeMint.denominate(sats) });

test('the feed record: creqA with one POST transport, no amount, no mint list, not single-use', async () => {
  const s = await start();
  const r = await (await fetch(`${s.base}/creq/${GUID}`)).json() as { request: string; feed_line: string };
  assert.match(r.feed_line, /^<podcast:txt purpose="cashu">creqA[A-Za-z0-9+/=_-]+<\/podcast:txt>$/);
  const d = decodeFeedRequest(r.request);
  assert.deepEqual(d.transport, [{ type: 'post', target: `${s.base}/pay/${GUID}` }]);
  assert.equal(d.amount, undefined);
  assert.equal(d.mints, undefined);
  assert.equal(d.singleUse, false);
  assert.equal(d.unit, 'sat');
  assert.equal(paymentUrl(r.request, { action: 'stream', episodeGuid: E301, ts: 61.7 }), `${s.base}/pay/${GUID}?action=stream&episode=${E301}&ts=61`);
  await s.close();
});

test('POST /pay books to the episode split; errors keep Sovereigncast\'s shape', async () => {
  const s = await start();
  let res = await fetch(`${s.base}/pay/${GUID}?episode=${E301}`, { method: 'POST', body: payload(s.mint.mintUrl, 21, 'gm') });
  let body = await res.json() as any;
  assert.equal(res.status, 200);
  assert.deepEqual([body.success, body.amount_sats, body.value_source], [true, 21, 'item']);
  assert.deepEqual(body.shares.map((x: any) => x.msat), [17_000, 4_000]);

  res = await fetch(`${s.base}/pay/${GUID}?action=stream&episode=${E301}&ts=30`, { method: 'POST', body: payload(s.mint.mintUrl, 5) });
  body = await res.json();
  assert.deepEqual(body.shares.map((x: any) => x.msat), [4_000, 1_000]);
  assert.equal(s.ledger.credits(GUID)[0].kind, 'stream');

  res = await fetch(`${s.base}/pay/${GUID}`, { method: 'POST', body: payload('https://elsewhere.mint', 5) });
  assert.deepEqual([res.status, await res.json()], [400, { success: false, error: 'untrusted_mint', accepted_mints: ['https://fake.mint'] }]);
  res = await fetch(`${s.base}/pay/${GUID}`, { method: 'POST', body: '{"nope":1}' });
  assert.deepEqual([res.status, await res.json()], [400, { success: false, error: 'invalid_payload' }]);
  res = await fetch(`${s.base}/pay/not-a-show`, { method: 'POST', body: payload(s.mint.mintUrl, 5) });
  assert.equal(res.status, 404);
  res = await fetch(`${s.base}/nothing`);
  assert.deepEqual([res.status, await res.json()], [404, { error: { code: 'not_found', message: 'no such endpoint' } }]);
  await s.close();
});

test('rate limit per IP, like Sovereigncast\'s 10/min', async () => {
  const s = await start(3);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await fetch(`${s.base}/pay/${GUID}`, { method: 'POST', body: payload(s.mint.mintUrl, 5) })).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
  await s.close();
});

test('the ledger: JSON with an ETag, HTML for people, capability document', async () => {
  const s = await start();
  await fetch(`${s.base}/pay/${GUID}?episode=${E301}`, { method: 'POST', body: payload(s.mint.mintUrl, 100, 'Valido, ergo sum') });
  const res = await fetch(`${s.base}/ledger/${GUID}?format=json`);
  const etag = res.headers.get('etag')!;
  const data = await res.json() as any;
  assert.equal(data.totals.received_sats, 100);
  assert.deepEqual(data.recipients.map((r: any) => [r.address, r.credited_msat, r.fee_payer]),
    [['nodesignal@getalby.com', 80_000, true], ['zettizettler@getalby.com', 20_000, false]]);
  assert.ok(data.reconcile.ok);
  assert.equal((await fetch(`${s.base}/ledger/${GUID}?format=json`, { headers: { 'if-none-match': etag } })).status, 304);
  const html = await (await fetch(`${s.base}/ledger/${GUID}`)).text();
  assert.match(html, /<title>Split ledger · Nodesignal/);
  assert.match(html, /Valido, ergo sum/);
  assert.match(html, /prefers-color-scheme:dark/);
  const cap = await (await fetch(`${s.base}/shows/${GUID}/ecash`)).json() as any;
  assert.equal(cap.ecash.split_settlement, true);
  assert.match(cap.ecash.nut18, /^creqA/);
  await s.close();
});
