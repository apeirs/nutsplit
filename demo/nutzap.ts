// Nutzap demo on a test mint: a listener's app reads the show's kind:10019,
// locks ecash to the key it names (NUT-11 P2PK) and publishes kind:9321
// nutzaps; nutsplit picks them up from the relay, redeems each exactly once,
// books it to the episode's split and pays the recipients.
//
//   node demo/nutzap.ts         (about 20 s; needs network to the test mints)
//
// Money: testnut.cashu.space (and testnut.cashudevkit.org for the stand-in
// invoices), fake sats only. The relay is a local one on 127.0.0.1 (nothing
// is published to a public relay), and every key is a throwaway made for
// this run in demo/out/nutzap/ (not in git) and never printed.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Wallet, MintQuoteState, serializeProofs, type Proof } from '@cashu/cashu-ts';
import { Ledger } from '../src/ledger.ts';
import { parseFeed } from '../src/feed.ts';
import { CashuMint } from '../src/mint.ts';
import { loadNutzapKey } from '../src/config.ts';
import { newSecretKey, publicKeyOf, signEvent, npub, tagValues, RelaySubscription, type NostrEvent } from '../src/nostr.ts';
import { nutzapInfoTemplate, type NutzapIdentity } from '../src/nutzap.ts';
import { processNutzap, startNutzapIntake, type NutzapOutcome } from '../src/nutzap-intake.ts';
import { settle } from '../src/settle.ts';
import { ledgerJson, ledgerHtml } from '../src/report.ts';
import { startLnurlStub } from './lnurl-stub.ts';
import { startLocalRelay } from '../test/local-relay.ts';
import type { Show } from '../src/accrue.ts';

const MINT = 'https://testnut.cashu.space';
const OTHER_MINT = 'https://testnut.cashudevkit.org';
const OUT = new URL('./out/nutzap/', import.meta.url);
const E301 = '7d3a1f3d-c709-4eaa-8f8b-2260330ee403';
const E300 = 'a07a0e11-6874-41bf-ad3c-c9c722e62aa6';

const say = (s = '') => console.log(s);
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const lpad = (s: unknown, n: number) => String(s).padStart(n);
const short = (id: string) => id.slice(0, 10) + '…';

/** A throwaway key, kept 0600 in the run's directory, never printed. */
function throwawayKey(name: string): string {
  const sk = newSecretKey();
  writeFileSync(new URL(`${name}.secret`, OUT), sk + '\n', { mode: 0o600 });
  return sk;
}

/** What an app does first: fetch the show's kind:10019 (one REQ until EOSE). */
function fetchNutzapInfo(relay: string, author: string): Promise<NostrEvent | undefined> {
  return new Promise((resolve) => {
    let found: NostrEvent | undefined;
    const sub = new RelaySubscription(relay, {
      filters: () => [{ kinds: [10019], authors: [author] }],
      onEvent: (e) => { if (!found || e.created_at > found.created_at) found = e; },
      onEose: () => { sub.close(); resolve(found); },
    }).start();
  });
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const feed = parseFeed(gunzipSync(readFileSync(new URL('../test/fixtures/nodesignal-feed.xml.gz', import.meta.url))).toString('utf8'));
  const show: Show = { podcastGuid: feed.podcastGuid!, feed, feePolicy: 'show' };
  const title = (g: string) => feed.items.find((i) => i.guid === g)!.title;
  const relay = await startLocalRelay();

  // ── the show: a Nostr identity, and nutsplit's own nutzap key ───────────
  const showSk = throwawayKey('show-nostr');
  const zapKey = loadNutzapKey(OUT.pathname);
  const identity: NutzapIdentity = { nostrPubkey: publicKeyOf(showSk), p2pkPubkey: zapKey.pubkey, mints: [MINT], relays: [relay.url] };
  relay.publish(signEvent(nutzapInfoTemplate(identity), showSk));
  say(`Show: ${feed.title}, Nostr ${npub(identity.nostrPubkey).slice(0, 16)}… (throwaway), relay ${relay.url} (local).`);
  say(`Its kind:10019, signed by the show's key: relay ${relay.url}, mint ${MINT} (sat), nutzap pubkey ${zapKey.pubkey.slice(0, 14)}… (nutsplit's own key, not the Nostr key)`);

  const ledger = new Ledger(new URL('nutsplit.sqlite', OUT).pathname);
  const seed = randomBytes(64);
  writeFileSync(new URL('seed.secret', OUT), seed.toString('hex'), { mode: 0o600 });
  const mint = new CashuMint(MINT, { seed, ledger });
  await mint.load();
  const outcomes: NutzapOutcome[] = [];
  const ctx = { ledger, show, mints: [mint], identity, p2pkPrivkey: zapKey.privkey };
  let intake = await startNutzapIntake(ctx, { onOutcome: (x) => outcomes.push(x) });
  say(`nutsplit subscribed: kinds [9321], #p [show], #u [${MINT}]`);
  say();

  // ── a listener's app (NIP-61 sender) ────────────────────────────────────
  const info = await fetchNutzapInfo(relay.url, identity.nostrPubkey);
  if (!info) throw new Error('no kind:10019 on the relay');
  const lockTo = tagValues(info, 'pubkey')[0];
  const zapMint = tagValues(info, 'mint')[0];
  say(`Listener's app read the kind:10019: lock to ${lockTo.slice(0, 14)}…, mint ${zapMint}`);
  const listenerSk = throwawayKey('listener-nostr');
  const wallet = new Wallet(zapMint);
  await wallet.loadMint();
  const q = await wallet.createMintQuoteBolt11(400);
  for (let i = 0; i < 20 && (await wallet.checkMintQuoteBolt11(q.quote)).state !== MintQuoteState.PAID; i++) await new Promise((r) => setTimeout(r, 500));
  let proofs: Proof[] = await wallet.mintProofsBolt11(400, q.quote);
  const events: NostrEvent[] = [info];
  const zap = async (sats: number, o: { content?: string; tags?: string[][]; lock?: string; u?: string; publish?: boolean } = {}) => {
    const { keep, send } = await wallet.send(sats, proofs, {}, { send: { type: 'p2pk', options: { pubkey: o.lock ?? lockTo } } });
    proofs = keep;
    const e = signEvent({
      kind: 9321, content: o.content ?? '',
      tags: [...serializeProofs(send).map((p) => ['proof', p]), ['unit', 'sat'], ['u', o.u ?? zapMint], ['p', identity.nostrPubkey], ...(o.tags ?? [])],
    }, listenerSk);
    events.push(e);
    if (o.publish !== false) relay.publish(e);
    return e;
  };
  const ctxTags = (g: string, ts: number) => [['episode', title(g)], ['episode_guid', g], ['ts', String(ts)], ['i', `podcast:item:guid:${g}`]];

  const t0 = Date.now();
  const boost = await zap(21, { content: `${title(E301)} · 00:42:00 — Danke für die Folge!`, tags: ctxTags(E301, 2520) });
  for (let i = 0; i < 10; i++) await zap(5, { content: `${title(E301)} · 00:0${i}:00`, tags: ctxTags(E301, 60 * i) });
  await zap(100, { tags: [['i', `podcast:item:guid:${E300}`]] });
  const wrongKey = await zap(4, { lock: '02' + publicKeyOf(newSecretKey()) });
  relay.publish(boost); // the same event delivered again
  const sameProofs = signEvent({ kind: 9321, content: 'same proofs, new event', tags: boost.tags }, listenerSk);
  events.push(sameProofs);
  relay.publish(sameProofs);
  const otherMint = await zap(2, { u: OTHER_MINT });
  say(`Published ${events.length - 1} kind:9321 events in ${((Date.now() - t0) / 1000).toFixed(1)} s: a 21-sat boost with a message, 10 streaming ticks of 5 sat (player head only), a silent 100 sat on E300,`);
  say('  one locked to someone else\'s key, the boost again, the boost\'s proofs in a new event, and one naming another mint.');

  // Every event but the kind:10019 and the other-mint one reaches nutsplit, and the boost twice.
  const delivered = events.length - 1;
  for (let i = 0; i < 200 && outcomes.length < delivered; i++) await new Promise((r) => setTimeout(r, 50));
  await intake.idle();
  say();
  say('What nutsplit did with each event it received:');
  for (const e of events.slice(1)) {
    const x = ledger.nutzap(e.id);
    const label = e === boost ? 'boost 21' : e === sameProofs ? 'same proofs' : e === wrongKey ? 'wrong key' : e === otherMint ? 'other mint' : `${tagValues(e, 'proof').reduce((s, p) => s + JSON.parse(p).amount, 0)} sat`;
    say(`  ${short(e.id)} ${pad(label, 12)} ${x ? `${pad(x.state, 9)} ${x.reason ?? (x.credit_id ? `credit #${x.credit_id}` : '')}` : 'not delivered (the relay filters #u: nutsplit never sees other mints)'}`);
  }
  say(`  the boost was delivered twice: ${outcomes.filter((x) => x.eventId === boost.id).map((x) => x.state).join(', ')}`);
  const direct = await processNutzap(ctx, otherMint);
  say(`  the other-mint event handed to nutsplit directly: ${direct.state} (${'reason' in direct ? direct.reason : ''}), mint not contacted`);

  // ── a restart: the relay sends everything again ─────────────────────────
  intake.close();
  const before = ledger.credits(show.podcastGuid).length;
  outcomes.length = 0;
  intake = await startNutzapIntake(ctx, { onOutcome: (x) => outcomes.push(x) });
  for (let i = 0; i < 200 && outcomes.length < delivered - 1; i++) await new Promise((r) => setTimeout(r, 50));
  await intake.idle();
  intake.close();
  say(`Restart: the relay re-sent ${outcomes.length} events (since = newest seen − 1 h); new credits: ${ledger.credits(show.podcastGuid).length - before}.`);
  say();

  // ── what was booked, then a settlement to the feed's recipients ─────────
  const credits = ledger.credits(show.podcastGuid).reverse();
  say(`Booked: ${credits.length} credits, ${credits.filter((c) => c.kind === 'boost').length} boosts + ${credits.filter((c) => c.kind === 'stream').length} streaming, rail nip61, sender ${credits[0].sender.slice(0, 14)}…`);
  for (const c of credits.filter((c) => c.kind === 'boost')) {
    const shares = ledger.db.prepare(`SELECT r.name, e.msat FROM entries e JOIN recipients r ON r.key = e.recipient_key WHERE e.credit_id = ? AND e.kind = 'share'`).all(c.id) as Array<{ name: string; msat: number }>;
    say(`  ${lpad(c.gross_msat / 1000, 4)} sat boost on ${(c.episode_title ?? 'show').split(' - ').slice(0, 2).join(' - ')}${c.message ? ` "${c.message}"` : ''}: ${shares.map((s) => `${s.name} ${s.msat / 1000}`).join(' + ')}`);
  }
  const stub = await startLnurlStub({
    invoiceMint: OTHER_MINT,
    addresses: {
      'nodesignal@getalby.com': 'nodesignal', 'zettizettler@getalby.com': 'zettizettler',
      'altbierjupp@getalby.com': 'altbierjupp', 'chrissha256@getalby.com': 'chrissha256',
    },
  });
  const rep = await settle({ ledger, show, mints: [mint], lnurl: { urlFor: stub.urlFor, isSafeUrl: stub.isSafeUrl }, thresholdSat: 100 }, { force: true });
  say('Settlement (episode-end cutoff):');
  for (const p of rep.payouts) say(`  ${pad(p.name.replace(/ <.*>$/, ''), 16)} ${lpad(p.amountSat, 4)} sat  ${pad(p.outcome, 8)}${p.feeSat !== undefined ? ` fee ${p.feeSat} sat` : ''}${p.reason ? `  (${p.reason})` : ''}`);
  const data = ledgerJson(ledger, show);
  const rec = data.reconcile;
  say(`Books vs wallet: owed ${rec.owedMsat} msat, wallet ${rec.walletMsat} msat (${rec.ok ? 'match' : 'MISMATCH'}); nutzaps: ${Object.entries(data.nutzaps.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}`);

  writeFileSync(new URL('events.json', OUT), JSON.stringify(events, null, 2));
  writeFileSync(new URL('ledger.json', OUT), JSON.stringify(data, null, 2));
  writeFileSync(new URL('ledger.html', OUT), ledgerHtml(data));
  say('\nWrote demo/out/nutzap/ledger.html, ledger.json and events.json (the public events only).');
  await stub.close();
  await relay.close();
  ledger.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
