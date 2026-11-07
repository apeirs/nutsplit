import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Ledger, type StoredProof } from '../src/ledger.ts';
import { parseFeed } from '../src/feed.ts';
import { accrue, bookReceipt, defaultFeePayer, type Show } from '../src/accrue.ts';
import { recipientKey } from '../src/split.ts';

const feed = parseFeed(gunzipSync(readFileSync(new URL('./fixtures/nodesignal-feed.xml.gz', import.meta.url))).toString('utf8'));
const GUID = feed.podcastGuid!;
const E301 = '7d3a1f3d-c709-4eaa-8f8b-2260330ee403';
const show: Show = { podcastGuid: GUID, feed, feePolicy: 'show' };
const MINT = 'https://mint.test';
let n = 0;
const proof = (amount: number): StoredProof => ({ id: '00ab', amount, secret: `s${++n}`, C: '02' + 'c'.repeat(64) });

test('a boost on E301 books 17 + 4 sats; a stream tick books millisats', () => {
  const l = new Ledger();
  bookReceipt(l, show, { episodeGuid: E301, kind: 'boost', grossMsat: 21_000, rail: 'test', intakeFeeMsat: 0 });
  bookReceipt(l, show, { episodeGuid: E301, kind: 'stream', grossMsat: 5_000, rail: 'test', intakeFeeMsat: 0 });
  const b = Object.fromEntries(l.balances(GUID).map((x) => [x.address, x.owed_msat]));
  assert.deepEqual(b, { 'nodesignal@getalby.com': 17_000 + 4_000, 'zettizettler@getalby.com': 4_000 + 1_000 });
});

test('the default fee payer is the show itself (channel block), and pays the intake fee', () => {
  assert.equal(defaultFeePayer(feed)?.address, 'nodesignal@getalby.com');
  const l = new Ledger();
  bookReceipt(l, show, { episodeGuid: E301, kind: 'boost', grossMsat: 100_000, rail: 'test', intakeFeeMsat: 1_000 });
  const b = Object.fromEntries(l.balances(GUID).map((x) => [x.address, x.owed_msat]));
  assert.deepEqual(b, { 'nodesignal@getalby.com': 79_000, 'zettizettler@getalby.com': 20_000 });
});

test('with feePolicy "recipient" the intake fee is shared', () => {
  const l = new Ledger();
  bookReceipt(l, { ...show, feePolicy: 'recipient' },
    { episodeGuid: E301, kind: 'boost', grossMsat: 101_000, rail: 'test', intakeFeeMsat: 1_000 });
  const b = Object.fromEntries(l.balances(GUID).map((x) => [x.address, x.owed_msat]));
  assert.deepEqual(b, { 'nodesignal@getalby.com': 80_000, 'zettizettler@getalby.com': 20_000 });
});

test('one credit per token: a replayed token hash is refused by the database', () => {
  const l = new Ledger();
  bookReceipt(l, show, { episodeGuid: E301, kind: 'boost', grossMsat: 21_000, rail: 'test', intakeFeeMsat: 0, tokenHash: 'h1' });
  assert.ok(l.hasToken('h1'));
  assert.throws(() => bookReceipt(l, show, { episodeGuid: E301, kind: 'boost', grossMsat: 21_000, rail: 'test', intakeFeeMsat: 0, tokenHash: 'h1' }),
    /UNIQUE/);
  assert.equal(l.creditTotals(GUID).count, 1);
});

test('replay 1 000 random credits over the real feed: recipient sums equal credit sums, to the millisat', () => {
  const l = new Ledger();
  let seed = 7;
  const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % k; };
  const items = feed.items.filter((i) => i.value);
  let gross = 0;
  let fees = 0;
  for (let i = 0; i < 1000; i++) {
    const it = rnd(10) === 0 ? undefined : items[rnd(items.length)];
    const kind = rnd(5) === 0 ? 'boost' : 'stream';
    const sats = kind === 'boost' ? 1 + rnd(5000) : 1 + rnd(30);
    const fee = rnd(4) === 0 ? 1 : 0;
    const a = accrue(show, it?.guid, kind, sats * 1000, rnd(3) === 0 ? rnd(6000) : undefined);
    // no share is ever larger than the credit, and none is zero
    assert.ok(a.shares.every((s) => s.msat > 0 && s.msat <= sats * 1000));
    bookReceipt(l, show, { episodeGuid: it?.guid, kind, grossMsat: sats * 1000, rail: 'test', intakeFeeMsat: fee * 1000 });
    l.addProofs(MINT, [proof(sats - fee)].filter((p) => p.amount > 0));
    gross += sats * 1000;
    fees += fee * 1000;
  }
  const bal = l.balances(GUID);
  const credited = bal.reduce((s, b) => s + b.credited_msat, 0);
  const owed = bal.reduce((s, b) => s + b.owed_msat, 0);
  assert.equal(credited, gross);
  assert.equal(owed, gross - fees);
  assert.equal(l.creditTotals(GUID).count, 1000);
  const rec = l.reconcile();
  assert.ok(rec.ok, JSON.stringify(rec));
  assert.equal(rec.owedMsat, rec.walletMsat);
  // sub-wallets on one node stay apart (E243: customValue 2 and 3)
  assert.ok(bal.filter((b) => b.address === '02d0fd6c2ec89fbbed6c94bd86e695b3d3086f3ecb7767da3123e519ee36d7bca2').length >= 2);
});

test('journal before send: reserve, then sent with a fee to the show, or failed and released', () => {
  const l = new Ledger();
  bookReceipt(l, show, { episodeGuid: E301, kind: 'boost', grossMsat: 1_000_000, rail: 'test', intakeFeeMsat: 0 });
  l.addProofs(MINT, [proof(512), proof(256), proof(128), proof(64), proof(32), proof(8)]);
  const guest = l.recipientKeys(GUID).find((k) => k.includes('zettizettler'))!;
  const host = l.recipientKeys(GUID).find((k) => k.includes('nodesignal'))!;
  assert.equal(l.owedMsat(GUID, guest), 200_000);

  const inputs = l.unspentProofs(MINT).filter((p) => [128, 64, 8].includes(p.amount)); // 200
  const extra = l.unspentProofs(MINT).find((p) => p.amount === 32)!; // fee reserve
  const id = l.journalPayout({ podcastGuid: GUID, recipientKey: guest, amountMsat: 200_000, rail: 'lnaddress', mintUrl: MINT,
    invoice: 'lnbc…', meltQuote: 'q1', feeReserveSat: 4, inputs: [...inputs, extra], outputDataJson: '[]' });
  assert.equal(l.payout(id)!.state, 'unknown');
  assert.equal(l.owedMsat(GUID, guest), 0, 'the amount leaves the balance before anything is sent');
  assert.throws(() => l.journalPayout({ podcastGuid: GUID, recipientKey: guest, amountMsat: 1_000, rail: 'lnaddress', mintUrl: MINT,
    invoice: 'x', meltQuote: 'q2', feeReserveSat: 2, inputs: [], outputDataJson: '[]' }), /exceeds owed/);
  assert.ok(l.reconcile().ok, 'in flight: reserved proofs cover the amount');

  l.settleSent(id, { preimage: 'ab'.repeat(32), change: [proof(16), proof(8), proof(4)], feePayer: defaultFeePayer(feed)! });
  const p = l.payout(id)!;
  assert.equal(p.state, 'sent');
  assert.equal(p.fee_msat, 4_000); // 232 in, 28 back, 200 paid
  assert.equal(l.owedMsat(GUID, guest), 0, 'the guest gets the exact share, the fee is not theirs');
  assert.equal(l.owedMsat(GUID, host), 800_000 - 4_000);
  assert.deepEqual(l.reconcile(), { owedMsat: 796_000, walletMsat: 796_000, reservedMsat: 0, unknownMsat: 0, ok: true });

  const id2 = l.journalPayout({ podcastGuid: GUID, recipientKey: host, amountMsat: 500_000, rail: 'lnaddress', mintUrl: MINT,
    invoice: 'lnbc…', meltQuote: 'q3', feeReserveSat: 10, inputs: l.unspentProofs(MINT).filter((p) => p.amount === 512), outputDataJson: '[]' });
  assert.throws(() => l.settleSent(id2 + 1, { change: [], feePayer: null }), /no payout/);
  l.settleFailed(id2, 'quote UNPAID, inputs unspent');
  assert.equal(l.payout(id2)!.state, 'failed');
  assert.equal(l.owedMsat(GUID, host), 796_000);
  assert.throws(() => l.settleFailed(id2, 'again'), /is failed, not unknown/);
  assert.ok(l.reconcile().ok);
});

test('skips are recorded once per reason and move no money', () => {
  const l = new Ledger();
  bookReceipt(l, show, { episodeGuid: E301, kind: 'boost', grossMsat: 21_000, rail: 'test', intakeFeeMsat: 0 });
  const k = recipientKey({ name: '', type: 'lnaddress', address: 'zettizettler@getalby.com', split: 0, fee: false });
  assert.ok(l.recordSkip(GUID, k, 4_000, 'lnaddress', 'share below the minimum (10 sats)'));
  assert.equal(l.recordSkip(GUID, k, 5_000, 'lnaddress', 'share below the minimum (10 sats)'), undefined);
  assert.equal(l.payouts(GUID, 'skipped').length, 1);
  assert.equal(l.payouts(GUID, 'skipped')[0].amount_msat, 5_000);
  assert.equal(l.owedMsat(GUID, k), 4_000);
});
