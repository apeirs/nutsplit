// Settlement against an in-memory mint and a stub LNURL server: batching,
// fees, unknown outcomes, unpayable shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Ledger } from '../src/ledger.ts';
import { parseFeed, type Feed } from '../src/feed.ts';
import type { Show } from '../src/accrue.ts';
import { receivePayment } from '../src/intake.ts';
import { settle, type SettleContext } from '../src/settle.ts';
import { decodeBolt11 } from '../src/bolt11.ts';
import { FakeMint } from './fake-mint.ts';
import { fakeInvoice } from './helpers.ts';

const xml = gunzipSync(readFileSync(new URL('./fixtures/nodesignal-feed.xml.gz', import.meta.url))).toString('utf8');
const E301 = '7d3a1f3d-c709-4eaa-8f8b-2260330ee403';
const E243_TITLE = 'Nodesignal-Talk - E243 - Saturdays for Satoshi';

/** A stub LNURL provider for any address: records what it was asked, answers with a matching invoice. */
function stubLnurl(opts: { minSendable?: number; commentAllowed?: number } = {}) {
  const asked: Array<{ address: string; amountMsat: number; comment?: string }> = [];
  const deps = {
    isSafeUrl: async () => true,
    urlFor: (user: string, domain: string) => `https://${domain}/.well-known/lnurlp/${user}`,
    fetch: (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.startsWith('/.well-known/lnurlp/')) {
        const user = u.pathname.split('/').pop();
        return Response.json({ tag: 'payRequest', callback: `https://${u.host}/cb/${user}`, minSendable: opts.minSendable ?? 1000,
          maxSendable: 1e11, commentAllowed: opts.commentAllowed ?? 255, metadata: '[]' });
      }
      const amountMsat = Number(u.searchParams.get('amount'));
      asked.push({ address: `${u.pathname.split('/').pop()}@${u.host}`, amountMsat, comment: u.searchParams.get('comment') ?? undefined });
      return Response.json({ pr: fakeInvoice(amountMsat / 1000), routes: [] });
    }) as typeof fetch,
  };
  return { deps, asked };
}

function setup(feed: Feed = parseFeed(xml), o: Partial<SettleContext> = {}, lnurlOpts = {}) {
  const ledger = new Ledger();
  const mint = new FakeMint();
  const show: Show = { podcastGuid: feed.podcastGuid!, feed, feePolicy: 'show' };
  const ln = stubLnurl(lnurlOpts);
  const ctx: SettleContext = { ledger, show, mints: [mint], lnurl: ln.deps, thresholdSat: 100, ...o };
  const pay = (sats: number, kind: 'boost' | 'stream', episodeGuid = E301, memo?: string) =>
    receivePayment({ ledger, show, mints: [mint] }, { mint: mint.mintUrl, proofs: FakeMint.denominate(sats), kind, episodeGuid, memo, rail: 'nut18' });
  return { ledger, mint, show, ctx, ln, pay };
}

test('50 listeners x 5-sat stream ticks + 2 boosts: one batched payout per recipient, exact shares', async () => {
  const { ledger, mint, ctx, ln, pay } = setup();
  for (let i = 0; i < 50; i++) {
    const r = await pay(5, 'stream');
    assert.ok(r.ok, JSON.stringify(r.body));
  }
  await pay(21, 'boost', E301, 'Danke für die Folge!');
  await pay(100, 'boost', E301, 'Valido, ergo sum');
  // 371 sats: host 80 % = 200 + 16.8 + 80, guest 20 % = 50 + 4 + 20 (whole-sat boosts, msat streams)
  const before = Object.fromEntries(ledger.balances(ctx.show.podcastGuid).map((b) => [b.address, b.owed_msat]));
  const intakeFees = ledger.creditTotals(ctx.show.podcastGuid).intake_fee_msat;
  assert.equal(before['zettizettler@getalby.com'], 74_000);
  assert.equal(before['nodesignal@getalby.com'], 297_000 - intakeFees);

  // threshold 100: the guest waits, the host is paid
  let rep = await settle(ctx);
  assert.deepEqual(rep.payouts.map((p) => p.outcome), ['waiting', 'sent']);
  // force (episode-end cutoff): the guest gets exactly 74
  rep = await settle(ctx, { force: true });
  const guest = rep.payouts.find((p) => p.name.includes('zettizettler'))!;
  assert.equal(guest.outcome, 'sent');
  assert.equal(guest.amountSat, 74);
  assert.deepEqual(mint.paid.map((p) => p.amountSat).slice(-1), [74]);
  assert.deepEqual(ln.asked.map((a) => a.address), ['nodesignal@getalby.com', 'zettizettler@getalby.com']);
  assert.match(ln.asked[1].comment!, /^nutsplit: Nodesignal · E301 · 2 boosts, 50 stream payments · "Danke für die Folge!" "Valido, ergo sum"$/);

  // every fee landed on the show, the guest's balance is zero, books equal wallet
  const after = Object.fromEntries(ledger.balances(ctx.show.podcastGuid).map((b) => [b.address, b]));
  assert.equal(after['zettizettler@getalby.com'].owed_msat, 0);
  assert.equal(after['zettizettler@getalby.com'].fees_msat, 0);
  assert.ok(after['nodesignal@getalby.com'].fees_msat > 0);
  assert.ok(ledger.reconcile().ok, JSON.stringify(ledger.reconcile()));
  for (const p of ledger.payouts(ctx.show.podcastGuid, 'sent')) {
    assert.equal(decodeBolt11(p.invoice!).amountMsat, p.amount_msat, 'invoice amount is the share');
    assert.ok(p.preimage);
  }
});

test('the show is paid its balance minus a fee reserve; the unused reserve carries', async () => {
  const { ledger, ctx, pay } = setup();
  await pay(1000, 'boost');
  const rep = await settle(ctx, { force: true });
  const host = rep.payouts.find((p) => p.name.includes('nodesignal'))!;
  assert.equal(host.outcome, 'sent');
  const guest = rep.payouts.find((p) => p.name.includes('zettizettler'))!;
  // owed: 800 - 1 sat intake fee - the guest's payout fee; paid that minus
  // the reserve max(2, 1 %) = 8 and the input fee
  const hostOwed = 799 - guest.feeSat!;
  assert.ok(host.amountSat >= hostOwed - 8 - 2 && host.amountSat <= hostOwed - 8, `paid ${host.amountSat} of ${hostOwed}`);
  const owed = ledger.owedMsat(ctx.show.podcastGuid, host.recipient);
  assert.equal(owed, (hostOwed - host.amountSat - host.feeSat!) * 1000, 'the unused reserve carries');
  assert.ok(owed >= 0);
  assert.ok(ledger.reconcile().ok);
});

// While the guest's payout is in flight its inputs (amount plus reserve) are
// locked, so the show, paid last, waits for the next pass ("wallet short").
test('no answer after the melt was sent: unknown, never paid again, settled by the mint\'s record', async () => {
  const { ledger, mint, ctx, pay } = setup(undefined, { graceMs: 0 });
  await pay(1000, 'boost');
  mint.mode = 'timeout_paid';
  let rep = await settle(ctx, { force: true });
  assert.deepEqual(rep.payouts.map((p) => [p.outcome, /wallet short/.test(p.reason ?? '')]), [['unknown', false], ['skipped', true]]);
  assert.equal(mint.paid.length, 1, 'the mint did pay the guest');
  mint.mode = 'pay';
  rep = await settle(ctx, { force: true });
  assert.deepEqual(rep.resolved.map((r) => r.state), ['sent']);
  assert.deepEqual(rep.payouts.map((p) => p.outcome), ['sent']);
  assert.deepEqual(mint.paid.map((p) => p.amountSat).slice(0, 1), [200], 'the guest was paid once, 200 sats');
  assert.equal(mint.paid.length, 2);
  assert.equal(ledger.payouts(ctx.show.podcastGuid, 'sent').length, 2);
  assert.ok(ledger.reconcile().ok);
});

test('no answer and the mint never got it: after the grace period the inputs are swapped, then released and paid once', async () => {
  let t = 0;
  const { ledger, mint, ctx, pay } = setup(undefined, { graceMs: 60_000, now: () => t });
  await pay(500, 'boost');
  mint.mode = 'timeout_unpaid';
  await settle(ctx, { force: true });
  assert.equal(ledger.payouts(ctx.show.podcastGuid, 'unknown').length, 1);
  mint.mode = 'pay';
  // within the grace period nothing is released and nothing re-paid
  t = Date.now();
  let rep = await settle(ctx, { force: true });
  assert.deepEqual(rep.resolved.map((r) => r.note), ['no answer yet, waiting out the grace period']);
  assert.equal(mint.paid.length, 0);
  t = Date.now() + 61_000;
  rep = await settle(ctx, { force: true });
  assert.deepEqual(rep.resolved.map((r) => r.state), ['failed']);
  assert.ok(mint.calls.includes('swap'), 'inputs swapped before release');
  assert.deepEqual(rep.payouts.map((p) => p.outcome), ['sent', 'sent']);
  assert.deepEqual(mint.paid.map((p) => p.amountSat)[0], 100, 'the guest, once');
  assert.equal(mint.paid.length, 2);
  assert.ok(ledger.reconcile().ok, JSON.stringify(ledger.reconcile()));
});

test('the mint refuses the payment: failed, released at once, retried next pass', async () => {
  const { ledger, mint, ctx, pay } = setup();
  await pay(500, 'boost');
  mint.mode = 'refuse';
  let rep = await settle(ctx, { force: true });
  assert.deepEqual(rep.payouts.map((p) => p.outcome), ['failed', 'failed']);
  assert.ok(ledger.reconcile().ok);
  mint.mode = 'pay';
  rep = await settle(ctx, { force: true });
  assert.deepEqual(rep.payouts.map((p) => p.outcome), ['sent', 'sent']);
});

test('PENDING stays unknown until the mint says PAID', async () => {
  const { ledger, mint, ctx, pay } = setup();
  await pay(500, 'boost');
  mint.mode = 'pending';
  await settle(ctx, { force: true });
  const unknown = ledger.payouts(ctx.show.podcastGuid, 'unknown');
  assert.equal(unknown.length, 1);
  mint.mode = 'pay';
  let rep = await settle(ctx, { force: true });
  assert.deepEqual(rep.resolved.map((r) => r.note), ['PENDING']);
  assert.equal(mint.paid.length, 0);
  for (const p of unknown) mint.completePending(p.melt_quote!);
  rep = await settle(ctx, { force: true });
  assert.deepEqual(rep.resolved.map((r) => r.state), ['sent']);
  assert.deepEqual(mint.paid.map((p) => p.amountSat)[0], 100);
  assert.equal(mint.paid.length, 2);
  assert.ok(ledger.reconcile().ok);
});

test('keysend recipients are unpayable by a mint: skipped and shown, never redistributed', async () => {
  const feed = parseFeed(xml);
  const e243 = feed.items.find((i) => i.title === E243_TITLE)!;
  const { ledger, ctx, pay, mint } = setup(feed);
  await pay(500, 'boost', e243.guid);
  const rep = await settle(ctx, { force: true });
  assert.ok(rep.payouts.every((p) => p.outcome === 'skipped' && /unpayable by mint/.test(p.reason!)));
  assert.equal(mint.paid.length, 0);
  const owed = ledger.balances(ctx.show.podcastGuid).map((b) => [b.address.slice(0, 10), b.custom_value, b.owed_msat]);
  // 80/20 between the two sub-wallets, exactly. The 1-sat intake fee goes to
  // the fee payer, the show's channel-level Lightning address.
  assert.deepEqual(owed, [['02d0fd6c2e', '2', 400_000], ['02d0fd6c2e', '3', 100_000],
    ['nodesignal', 'https://getalby.com/lnurlp/nodesignal/callback', -1_000]]);
  assert.equal(ledger.payouts(ctx.show.podcastGuid, 'skipped').length, 2);
});

test('a share below the provider\'s minimum is skipped and stays owed', async () => {
  const { ledger, ctx, pay, mint } = setup(undefined, {}, { minSendable: 50_000 });
  await pay(100, 'boost');
  const rep = await settle(ctx, { force: true });
  const guest = rep.payouts.find((p) => p.name.includes('zettizettler'))!;
  assert.equal(guest.outcome, 'skipped');
  assert.match(guest.reason!, /below the minimum \(50 sats\)/);
  assert.equal(ledger.owedMsat(ctx.show.podcastGuid, guest.recipient), 20_000);
  assert.equal(mint.paid.length, 1);
});

test('a provider without comments: paid, memo reported as not carried', async () => {
  const { ledger, ctx, pay } = setup(undefined, {}, { commentAllowed: 0 });
  await pay(500, 'boost', E301, 'hallo');
  const rep = await settle(ctx, { force: true });
  assert.ok(rep.payouts.every((p) => p.outcome === 'sent' && p.memoCarried === false));
  assert.ok(ledger.payouts(ctx.show.podcastGuid, 'sent').every((p) => p.memo_carried === 0));
});

test('with a public URL the comment follows rss::payment', async () => {
  const { ctx, ln, pay } = setup(undefined, { publicUrl: 'https://split.example/' });
  await pay(500, 'boost', E301, 'gm');
  await settle(ctx, { force: true });
  assert.match(ln.asked[0].comment!, /^rss::payment::boost https:\/\/split\.example\/ledger\/e8df0b13-47de-544a-99b7-ec7cbd960a16 nutsplit: /);
});

test('intake errors mirror Sovereigncast\'s endpoint', async () => {
  const { ledger, show, mint } = setup();
  const ictx = { ledger, show, mints: [mint] };
  const proofs = FakeMint.denominate(21);
  const base = { mint: mint.mintUrl, proofs, kind: 'boost' as const, episodeGuid: E301, rail: 'nut18' };
  let r = await receivePayment(ictx, { ...base, mint: 'https://other.mint' });
  assert.deepEqual([r.status, r.body.success ? '' : r.body.error, (r.body as any).accepted_mints], [400, 'untrusted_mint', ['https://fake.mint']]);
  r = await receivePayment(ictx, { ...base, unit: 'usd' });
  assert.equal(r.body.success ? '' : r.body.error, 'unsupported_unit');
  r = await receivePayment(ictx, { ...base, proofs: [{ ...proofs[0], secret: 1 as any }] });
  assert.equal(r.body.success ? '' : r.body.error, 'invalid_payload');
  r = await receivePayment(ictx, { ...base, proofs: FakeMint.denominate(1) });
  assert.equal(r.body.success ? '' : r.body.error, 'amount_too_small');
  r = await receivePayment(ictx, base);
  assert.equal(r.status, 200);
  r = await receivePayment(ictx, base);
  assert.deepEqual([r.status, r.body.success ? '' : r.body.error], [409, 'already_redeemed']);
  const spentElsewhere = FakeMint.denominate(8);
  for (const p of spentElsewhere) mint.spent.add(p.secret);
  r = await receivePayment(ictx, { ...base, proofs: spentElsewhere });
  assert.deepEqual([r.status, r.body.success ? '' : r.body.error], [400, 'already_spent']);
  const noValue = parseFeed('<rss><channel><title>T</title><item><guid>x</guid></item></channel></rss>');
  r = await receivePayment({ ...ictx, show: { ...show, feed: noValue } }, { ...base, proofs: FakeMint.denominate(8) });
  assert.equal(r.body.success ? '' : r.body.error, 'no_value_block');
  assert.equal(ledger.creditTotals(show.podcastGuid).count, 1);
});
