// End-to-end demo on test mints: listeners stream and boost Nodesignal
// episodes over NUT-18, nutsplit books every payment to the episode's real
// podcast:value split, then pays each recipient in one batched melt.
//
//   node demo/run.ts            (about a minute; needs network to the test mints)
//
// Money: testnut.cashu.space and testnut.cashudevkit.org only. Their
// Lightning is simulated: mint quotes pay themselves, melts are marked paid.
// The feed's Lightning addresses are mapped to a local LNURL stand-in; any
// other address is refused (demo/lnurl-stub.ts).
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Wallet, MintQuoteState, type Proof } from '@cashu/cashu-ts';
import { Ledger } from '../src/ledger.ts';
import { parseFeed, valueFor } from '../src/feed.ts';
import { CashuMint } from '../src/mint.ts';
import { createNutsplitServer } from '../src/server.ts';
import { settle } from '../src/settle.ts';
import { payShow } from '../src/listener.ts';
import { ledgerJson } from '../src/report.ts';
import { startLnurlStub } from './lnurl-stub.ts';
import type { Show } from '../src/accrue.ts';

const SETTLER_MINT = 'https://testnut.cashu.space';
const OTHER_MINT = 'https://testnut.cashudevkit.org';
const OUT = new URL('./out/', import.meta.url);
const E301 = '7d3a1f3d-c709-4eaa-8f8b-2260330ee403';
const E300 = 'a07a0e11-6874-41bf-ad3c-c9c722e62aa6';
const E299 = '9bf0fb90-9f6e-486c-bce6-1c0b8d500469';
const THRESHOLD = 100;

const say = (s = '') => console.log(s);
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const lpad = (s: unknown, n: number) => String(s).padStart(n);

async function fundedWallet(mintUrl: string, sats: number): Promise<{ wallet: Wallet; proofs: Proof[] }> {
  const wallet = new Wallet(mintUrl);
  await wallet.loadMint();
  const q = await wallet.createMintQuoteBolt11(sats);
  for (let i = 0; i < 20; i++) {
    const s = await wallet.checkMintQuoteBolt11(q.quote);
    if (s.state === MintQuoteState.PAID) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { wallet, proofs: await wallet.mintProofsBolt11(sats, q.quote) };
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const seed = randomBytes(64);
  writeFileSync(new URL('seed.secret', OUT), seed.toString('hex'), { mode: 0o600 });

  // ── the show ────────────────────────────────────────────────────────────
  const feed = parseFeed(gunzipSync(readFileSync(new URL('../test/fixtures/nodesignal-feed.xml.gz', import.meta.url))).toString('utf8'));
  const show: Show = { podcastGuid: feed.podcastGuid!, feed, feePolicy: 'show' };
  say(`Feed: ${feed.title} (snapshot 2026-11-07, ${feed.items.length} items)`);
  for (const g of [E301, E300, E299]) {
    const { block, item } = valueFor(feed, g);
    say(`  ${item!.title.split(' - ').slice(0, 2).join(' - ')}: ${block!.recipients.map((r) => `${r.name || r.address} ${r.split}% (${r.type})`).join(', ')}`);
  }

  // ── stand-ins for the recipients' Lightning-address providers ───────────
  const stub = await startLnurlStub({
    invoiceMint: OTHER_MINT,
    addresses: {
      'nodesignal@getalby.com': 'nodesignal', 'zettizettler@getalby.com': 'zettizettler',
      'altbierjupp@getalby.com': 'altbierjupp', 'chrissha256@getalby.com': 'chrissha256',
    },
  });
  say(`LNURL stand-in on 127.0.0.1:${stub.port} for 4 of the feed's Lightning addresses; every other address is refused.`);

  // ── nutsplit ────────────────────────────────────────────────────────────
  const ledger = new Ledger(new URL('nutsplit.sqlite', OUT).pathname);
  const mint = new CashuMint(SETTLER_MINT, { seed, ledger });
  await mint.load();
  const server = createNutsplitServer({ ledger, shows: [show], mints: [mint], rateLimitPerMin: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { request: creq, feed_line } = await (await fetch(`${base}/creq/${show.podcastGuid}`)).json() as { request: string; feed_line: string };
  say(`nutsplit on ${base}, accepting ${SETTLER_MINT}. Feed record it generates:`);
  say(`  ${feed_line}`);
  say();

  // ── listeners ───────────────────────────────────────────────────────────
  const l = await fundedWallet(SETTLER_MINT, 1000);
  let proofs = l.proofs;
  const pay = async (sats: number, episodeGuid: string, action: 'stream' | 'boost', memo?: string, ts?: number) => {
    const r = await payShow({ creq, wallet: l.wallet, proofs, sats, episodeGuid, action, memo, ts });
    proofs = r.proofs;
    if (r.status !== 200) throw new Error(`payment refused: ${JSON.stringify(r.body)}`);
    return r.body;
  };

  // A mint the show does not take: the answer names the ones it does.
  const other = await fundedWallet(OTHER_MINT, 8);
  const refused = await payShow({ creq, wallet: other.wallet, proofs: other.proofs, sats: 8, episodeGuid: E301, action: 'boost' });
  say(`A payment from ${OTHER_MINT}: HTTP ${refused.status} ${JSON.stringify(refused.body)}`);

  const t0 = Date.now();
  const sum = (ps: Proof[]) => ps.reduce((x, p) => x + p.amount.toNumber(), 0);
  const beforeTicks = sum(proofs);
  for (let i = 0; i < 50; i++) await pay(5, E301, 'stream', undefined, 60 * i);
  const listenerTickFees = beforeTicks - sum(proofs) - 250; // the listener wallet's own swaps to make 5-sat amounts
  const b1 = await pay(21, E301, 'boost', 'Danke für die Folge!');
  const b2 = await pay(100, E301, 'boost', 'Valido, ergo sum');
  await pay(210, E300, 'boost', '18 Jahre Bitcoin, Prost');
  await pay(100, E299, 'boost', 'Gemischter Satz');
  say(`50 stream payments of 5 sat on E301 + 4 boosts (21 and 100 on E301, 210 on E300, 100 on E299) POSTed in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  say(`  the 21-sat boost was booked as: ${b1.shares.map((s: any) => `${s.name} ${s.msat / 1000}`).join(' + ')} sat`);
  say(`  the 100-sat boost: ${b2.shares.map((s: any) => `${s.name} ${s.msat / 1000}`).join(' + ')} sat`);
  say();

  // ── settlement ──────────────────────────────────────────────────────────
  const ctx = { ledger, show, mints: [mint], lnurl: { urlFor: stub.urlFor, isSafeUrl: stub.isSafeUrl }, thresholdSat: THRESHOLD };
  const printPass = (title: string, rep: Awaited<ReturnType<typeof settle>>) => {
    say(title);
    for (const p of rep.payouts) {
      say(`  ${pad(p.name.replace(/ <.*>$/, ''), 16)} ${lpad(p.amountSat, 4)} sat  ${pad(p.outcome, 8)}${p.feeSat !== undefined ? ` fee ${p.feeSat} sat` : ''}${p.reason ? `  (${p.reason})` : ''}`);
    }
  };
  printPass(`Settlement pass, threshold ${THRESHOLD} sat:`, await settle(ctx));
  printPass('Episode-end cutoff (pay every whole sat still owed):', await settle(ctx, { force: true }));
  say();

  // ── what the recipients' stand-ins saw ──────────────────────────────────
  say('What the LNURL stand-ins were asked for (one invoice per recipient per batch):');
  const paidInvoices = new Set(ledger.payouts(show.podcastGuid, 'sent').map((p) => p.invoice));
  for (const r of stub.received) {
    say(`  ${pad(r.user, 13)} ${lpad(r.amountMsat / 1000, 4)} sat  ${paidInvoices.has(r.invoice) ? 'paid    ' : 'not used'}  comment: ${r.comment ?? '(none)'}`);
  }
  say('  ("not used": the show\'s first invoice, asked again smaller once the mint\'s real fee reserve was known)');
  say();

  // ── the ledger ──────────────────────────────────────────────────────────
  const data = ledgerJson(ledger, show);
  say(`Ledger (${base}/ledger/${show.podcastGuid}):`);
  say(`  ${pad('recipient', 16)} ${lpad('credited', 9)} ${lpad('paid', 5)} ${lpad('fees', 5)} ${lpad('owed', 8)}  paid by`);
  for (const r of data.recipients) {
    say(`  ${pad(r.name.slice(0, 16), 16)} ${lpad((r.credited_msat / 1000).toFixed(1), 9)} ${lpad(r.paid_sats, 5)} ${lpad(r.fees_sats, 5)} ${lpad((r.owed_msat / 1000).toFixed(3), 8)}  ${r.reachable ? 'melt to Lightning address' : 'keysend: unpayable by mint, kept owed'}`);
  }
  const t = data.totals;
  say(`  received ${t.received_sats} sat in ${t.credits} payments; paid out ${t.paid_sats} sat in ${data.payouts.filter((p) => p.state === 'sent').length} payouts; fees: ${t.intake_fee_sats} sat intake (one swap per payment), ${t.payout_fee_sats} sat payout`);
  const rec = data.reconcile;
  say(`  books vs wallet: owed ${rec.owedMsat} msat, wallet ${rec.walletMsat} msat (${rec.ok ? 'match' : 'MISMATCH'})`);
  say('Payouts:');
  for (const p of data.payouts.filter((x) => x.state !== 'skipped')) {
    say(`  #${p.id} ${pad(p.recipient, 14)} ${lpad(p.amount_sats, 4)} sat ${pad(p.state, 6)} fee ${p.fee_sats} sat  hash ${p.payment_hash?.slice(0, 16)}…  preimage ${p.preimage ? p.preimage.slice(0, 8) + '…' : 'none (test mint returns none)'}`);
  }
  say();

  // ── per-listener melts vs one batch: real quotes from the same test mint ─
  const quoteFor = async (sats: number) => {
    const inv = (await other.wallet.createMintQuoteBolt11(sats)).request;
    return (await l.wallet.createMeltQuoteBolt11(inv)).fee_reserve.toNumber();
  };
  const reserves = new Map<number, number>();
  for (const s of [1, 4, 17, 74, 230, 297]) reserves.set(s, await quoteFor(s));
  const perTick = (reserves.get(4)! + reserves.get(1)!);
  say('Fee reserve a melt needs on testnut (real quotes): ' + [...reserves].map(([s, f]) => `${s} sat → ${f}`).join(', '));
  say(`  per listener, each 5-sat tick split 80/20 is two melts (4 + 1 sat): ${perTick} sat of reserve for 5 sat sent`);
  // Measured, not quoted: three ticks paid the per-listener way, from the
  // listener's own wallet, each share melted to the recipient's invoice.
  const balance = () => proofs.reduce((x, p) => x + p.amount.toNumber(), 0);
  const costs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const before = balance();
    for (const share of [4, 1]) {
      const inv = (await other.wallet.createMintQuoteBolt11(share)).request;
      const q = await l.wallet.createMeltQuoteBolt11(inv);
      const { keep, send } = await l.wallet.send(q.amount.add(q.fee_reserve), proofs, { includeFees: true });
      const r = await l.wallet.meltProofsBolt11(q, send);
      proofs = [...keep, ...r.change];
    }
    costs.push(before - balance() - 5);
  }
  const perTickCost = costs.reduce((a, b) => a + b, 0) / costs.length;
  say(`  measured: three 5-sat ticks paid per listener cost ${costs.join(', ')} sat in fees each (two melts per tick)`);
  const sent = data.payouts.filter((p) => p.state === 'sent');
  say(`  nutsplit: ${sent.length} melts for ${t.paid_sats} sat paid, ${t.payout_fee_sats} sat payout fees (${((100 * t.payout_fee_sats) / t.paid_sats).toFixed(1)} %), plus 1 sat intake swap per payment (${t.intake_fee_sats} sat)`);
  say(`  the 50 ticks, all fees counted: per listener ≈ ${Math.round(50 * perTickCost)} sat (3 measured × 50); via nutsplit ${listenerTickFees} sat in the listener's wallet + 50 sat intake + a share of the ${t.payout_fee_sats} sat payout fees`);

  writeFileSync(new URL('ledger.json', OUT), JSON.stringify(data, null, 2));
  const { ledgerHtml } = await import('../src/report.ts');
  writeFileSync(new URL('ledger.html', OUT), ledgerHtml(data));
  say(`\nWrote demo/out/ledger.html and demo/out/ledger.json.`);
  server.close();
  await stub.close();
  ledger.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
