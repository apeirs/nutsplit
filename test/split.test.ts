// Every split case from Sovereigncast's tests/test_v4v_boost_split.py, the
// Hopp cases RESEARCH.md names, and a randomized conservation check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  splitRecipients, resolveValue, isKeysend, isLnaddress, recipientKey,
  type Recipient, type ValueBlock,
} from '../src/split.ts';

const NODE = 'a'.repeat(66);

function r(name: string, address: string, split: number, kw: Partial<Recipient> = {}): Recipient {
  return { name, type: '', address, split, fee: false, ...kw };
}
const byName = (out: ReturnType<typeof splitRecipients>) =>
  Object.fromEntries(out.map((x) => [x.recipient.name, x.amount]));

// ── Splitting (Sovereigncast) ────────────────────────────────────────────────

test('shares sum to the total even when they do not divide evenly', () => {
  const out = splitRecipients([r('a', NODE, 1), r('b', 'b@x.invalid', 1), r('c', 'c@x.invalid', 1)], 100);
  assert.equal(out.reduce((s, x) => s + x.amount, 0), 100);
  assert.deepEqual(out.map((x) => x.amount).sort((a, b) => a - b), [33, 33, 34]);
});

test('weights decide the shares', () => {
  assert.deepEqual(byName(splitRecipients([r('big', NODE, 90), r('small', 'b@x.invalid', 10)], 1000)),
    { big: 900, small: 100 });
});

test('a recipient without an address is not paid', () => {
  const out = splitRecipients([r('paid', NODE, 50), r('nowhere', '', 50)], 100);
  assert.deepEqual(out.map((x) => x.recipient.name), ['paid']);
});

test('a share rounding to zero is dropped rather than sent as zero', () => {
  const out = splitRecipients([r('big', NODE, 999), r('dust', 'd@x.invalid', 1)], 10);
  assert.ok(out.every((x) => x.amount > 0));
  assert.equal(out.reduce((s, x) => s + x.amount, 0), 10);
});

test('no split weights at all pays nobody', () => {
  assert.deepEqual(splitRecipients([r('a', NODE, 0), r('b', 'b@x.invalid', 0)], 100), []);
});

test('a fee recipient takes its percentage off the top', () => {
  const out = splitRecipients([r('host', NODE, 50), r('cohost', 'c@x.invalid', 50),
    r('index', 'i@x.invalid', 1, { fee: true })], 1000);
  assert.deepEqual(byName(out), { host: 495, cohost: 495, index: 10 });
});

test('the same division as the listener app (odd sat of a tie goes to feed order)', () => {
  const out = splitRecipients([r('host', NODE, 50), r('cohost', 'c@x.invalid', 50),
    r('index', 'i@x.invalid', 1, { fee: true })], 100);
  assert.deepEqual(byName(out), { host: 50, cohost: 49, index: 1 });
});

test('a block of only fee recipients is divided by weight', () => {
  const out = splitRecipients([r('a', NODE, 1, { fee: true }), r('b', 'b@x.invalid', 3, { fee: true })], 100);
  assert.deepEqual(byName(out), { a: 25, b: 75 });
});

test('the feed key fee counts as well', () => {
  const out = splitRecipients([r('host', NODE, 100), r('app', 'a@x.invalid', 5, { fee: true })], 100);
  assert.deepEqual(byName(out), { host: 95, app: 5 });
});

// ── Hopp ─────────────────────────────────────────────────────────────────────

test('Hopp ADR 0005: 21 sats at 80/20 are 17 + 4', () => {
  const out = splitRecipients([r('host', 'h@x.invalid', 80), r('guest', 'g@x.invalid', 20)], 21);
  assert.deepEqual(byName(out), { host: 17, guest: 4 });
});

test('Hopp ADR 0014: streaming splits to the millisat (21 sats = 16 800 + 4 200 msat)', () => {
  const out = splitRecipients([r('host', 'h@x.invalid', 80), r('guest', 'g@x.invalid', 20)], 21_000);
  assert.deepEqual(byName(out), { host: 16_800, guest: 4_200 });
});

test('Hopp H-02: fees claiming 100 % or more share the total by weight, never overflow it', () => {
  // Sovereigncast would give 60 + 60 = 120 of 100 here.
  const out = splitRecipients([r('host', NODE, 100), r('f1', 'a@x.invalid', 60, { fee: true }),
    r('f2', 'b@x.invalid', 60, { fee: true })], 100);
  assert.deepEqual(byName(out), { f1: 50, f2: 50 });
  const capped = splitRecipients([r('host', NODE, 100), r('greedy', 'g@x.invalid', 250, { fee: true })], 100);
  assert.deepEqual(byName(capped), { greedy: 100 });
});

test('fees summing to exactly 100 % match Sovereigncast', () => {
  const out = splitRecipients([r('host', NODE, 100), r('f1', 'a@x.invalid', 70, { fee: true }),
    r('f2', 'b@x.invalid', 30, { fee: true })], 1000);
  assert.deepEqual(byName(out), { f1: 700, f2: 300 });
});

test('5 000 random blocks: parts always add up to exactly the amount', () => {
  let seed = 42;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let k = 0; k < 5000; k++) {
    const n = 1 + rnd(8);
    const recs = Array.from({ length: n }, (_, i) =>
      r(`r${i}`, rnd(10) === 0 ? '' : `r${i}@x.invalid`, rnd(5) === 0 ? 0 : rnd(150), { fee: rnd(4) === 0 }));
    const amount = rnd(3) === 0 ? rnd(30) : rnd(5_000_000);
    const out = splitRecipients(recs, amount);
    const total = out.reduce((s, x) => s + x.amount, 0);
    const payable = recs.some((x) => x.address && Math.trunc(x.split) > 0);
    assert.ok(total <= amount);
    if (payable && amount > 0) assert.equal(total, amount, JSON.stringify({ recs, amount, out }));
    assert.ok(out.every((x) => x.amount > 0 && Number.isInteger(x.amount)));
  }
});

// ── Time splits (Sovereigncast) ──────────────────────────────────────────────

const V4V_WITH_TIME_SPLIT: ValueBlock = {
  type: 'lightning', method: 'keysend',
  recipients: [r('host', NODE, 100)],
  timeSplits: [{ startTime: 600, duration: 120, remotePercentage: 90,
    recipients: [r('guest', 'guest@x.invalid', 100)] }],
};

test('inside the window the remote share goes to the split recipients', () => {
  assert.deepEqual(byName(resolveValue(V4V_WITH_TIME_SPLIT, 660, 1000)), { host: 100, guest: 900 });
});

test('outside the window everything goes to the base recipients', () => {
  assert.deepEqual(byName(resolveValue(V4V_WITH_TIME_SPLIT, 59, 1000)), { host: 1000 });
});

test('a boost without a position never lands in a time split', () => {
  const v4v: ValueBlock = { type: 'lightning', method: 'keysend', recipients: [r('host', NODE, 100)],
    timeSplits: [{ startTime: 0, duration: 120, remotePercentage: 100,
      recipients: [r('guest', 'guest@x.invalid', 100)] }] };
  assert.deepEqual(new Set(resolveValue(v4v, null, 1000).map((x) => x.recipient.name)), new Set(['host']));
  assert.deepEqual(new Set(resolveValue(v4v, 0, 1000).map((x) => x.recipient.name)), new Set(['guest']));
});

test('a remote-item split without a resolver pays the base block, with one it pays the remote recipients', () => {
  const v4v: ValueBlock = { type: 'lightning', method: 'keysend', recipients: [r('host', NODE, 100)],
    timeSplits: [{ startTime: 0, duration: 91, remotePercentage: 95, recipients: [],
      remoteItem: { feedGuid: 'a85e9a93-f3ce-5c45-9cf9-508e3b14cf17' } }] };
  assert.deepEqual(byName(resolveValue(v4v, 10, 1000)), { host: 1000 });
  assert.deepEqual(byName(resolveValue(v4v, 10, 1000, () => [r('artist', 'artist@x.invalid', 100)])),
    { host: 50, artist: 950 });
});

// ── Classification ───────────────────────────────────────────────────────────

test('recipient classification (Sovereigncast parametrized cases)', () => {
  const cases: Array<[Pick<Recipient, 'type' | 'address'>, boolean, boolean]> = [
    [{ type: 'node', address: NODE }, true, false],
    [{ type: 'keysend', address: NODE }, true, false],
    [{ type: '', address: NODE }, true, false],
    [{ type: 'lnaddress', address: 'sat@x.invalid' }, false, true],
    [{ type: '', address: 'sat@x.invalid' }, false, true],
    [{ type: 'lnaddress', address: 'not-an-address' }, false, false],
  ];
  for (const [rec, ks, ln] of cases) {
    assert.equal(isKeysend(rec), ks, JSON.stringify(rec));
    assert.equal(isLnaddress(rec), ln, JSON.stringify(rec));
  }
});

test('sub-wallets on one node keep separate balances (Hopp M-05); an lnaddress ignores its callback hint', () => {
  const a = r('Nodesignal', '02d0fd', 80, { type: 'node', customKey: '696969', customValue: '2' });
  const b = r('Cutting', '02d0fd', 20, { type: 'node', customKey: '696969', customValue: '3' });
  assert.notEqual(recipientKey(a), recipientKey(b));
  const c1 = r('Nodesignal LN', 'nodesignal@getalby.com', 100, { type: 'lnaddress' });
  const c2 = r('Nodesignal LN', 'Nodesignal@getalby.com', 80,
    { type: 'lnaddress', customKey: 'lnurl_callback', customValue: 'https://getalby.com/lnurlp/nodesignal/callback' });
  assert.equal(recipientKey(c1), recipientKey(c2));
});

// ── Golden vectors from Sovereigncast's own Python ───────────────────────────
// test/fixtures/sovereigncast-split-vectors.json was produced by running
// community.py's _resolve_v4v_value on 600 random blocks (fees ≥ 100 % next to
// weighted recipients left out: that is the H-02 case where the two differ).


test('identical output to Sovereigncast on 600 random blocks', () => {
  const { cases } = JSON.parse(readFileSync(new URL('./fixtures/sovereigncast-split-vectors.json', import.meta.url), 'utf8'));
  const conv = (x: { name: string; address: string; split: number; is_fee?: boolean }): Recipient =>
    ({ name: x.name, type: '', address: x.address, split: x.split, fee: Boolean(x.is_fee) });
  for (const c of cases) {
    const block: ValueBlock = {
      type: 'lightning', method: 'keysend',
      recipients: c.v4v.recipients.map(conv),
      timeSplits: c.v4v.time_splits.map((s: any) => ({ startTime: s.start_time, duration: s.duration,
        remotePercentage: s.remote_percentage, recipients: s.recipients.map(conv) })),
    };
    const out = resolveValue(block, c.ts, c.amount).map((x) => [x.recipient.name, x.amount]);
    assert.deepEqual(out, c.out, JSON.stringify(c));
  }
  assert.equal(cases.length, 600);
});
