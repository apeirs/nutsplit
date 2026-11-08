// NIP-61 nutzap intake: event checks, P2PK redemption against a mint that
// enforces NUT-11, exactly-once processing, recovery, and the relay loop.
// Keys are made fresh for each run; nothing here touches the network except
// a relay on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createP2PKsecret, createHTLCsecret } from '@cashu/cashu-ts';
import { Ledger, type StoredProof } from '../src/ledger.ts';
import { parseFeed } from '../src/feed.ts';
import { newSecretKey, publicKeyOf, signEvent, verifyEvent, npub, toHexPubkey, type NostrEvent } from '../src/nostr.ts';
import { parseNutzap, listenerMessage, nutzapInfoTemplate, nutzapFilter, MAX_PROOFS_PER_EVENT, type NutzapIdentity } from '../src/nutzap.ts';
import { processNutzap, recoverNutzaps, retryNutzaps, startNutzapIntake, CURSOR_SLACK_S, type NutzapIntakeContext } from '../src/nutzap-intake.ts';
import { receivePayment } from '../src/intake.ts';
import { ledgerJson, ledgerHtml } from '../src/report.ts';
import { loadNutzapKey, nutzapIdentity } from '../src/config.ts';
import { FakeMint } from './fake-mint.ts';
import { startLocalRelay } from './local-relay.ts';
import type { Show } from '../src/accrue.ts';

const feed = parseFeed(gunzipSync(readFileSync(new URL('./fixtures/nodesignal-feed.xml.gz', import.meta.url))).toString('utf8'));
const GUID = feed.podcastGuid!;
const E301 = '7d3a1f3d-c709-4eaa-8f8b-2260330ee403';
const E301_TITLE = feed.items.find((i) => i.guid === E301)!.title;
const E300 = 'a07a0e11-6874-41bf-ad3c-c9c722e62aa6';
const MINT = 'https://fake.mint';

const showSk = newSecretKey();
const senderSk = newSecretKey();
const p2pkSk = newSecretKey();
const identity: NutzapIdentity = { nostrPubkey: publicKeyOf(showSk), p2pkPubkey: '02' + publicKeyOf(p2pkSk), mints: [MINT], relays: [] };

/** Proofs as a mint would issue them, P2PK-locked to `pubkey` (our nutzap key by default). */
function locked(amounts: number[], pubkey = identity.p2pkPubkey, tags?: string[][]): StoredProof[] {
  return FakeMint.proofs(amounts).map((p) => ({ ...p, secret: createP2PKsecret(pubkey, tags) }));
}

function nutzap(o: { proofs: StoredProof[]; content?: string; tags?: string[][]; mint?: string; p?: string; unit?: string; created_at?: number; sk?: string }): NostrEvent {
  return signEvent({
    kind: 9321, content: o.content ?? '', created_at: o.created_at,
    tags: [...o.proofs.map((p) => ['proof', JSON.stringify(p)]), ['unit', o.unit ?? 'sat'], ['u', o.mint ?? MINT], ['p', o.p ?? identity.nostrPubkey], ...(o.tags ?? [])],
  }, o.sk ?? senderSk);
}

function setup(): NutzapIntakeContext & { mint: FakeMint } {
  const mint = new FakeMint(MINT);
  const show: Show = { podcastGuid: GUID, feed, feePolicy: 'show' };
  return { ledger: new Ledger(), show, mints: [mint], mint, identity, p2pkPrivkey: p2pkSk };
}

test('NIP-01: sign and verify; a changed byte, id or signature fails; npub round trip', () => {
  const e = nutzap({ proofs: locked([1]) });
  assert.ok(verifyEvent(e));
  assert.equal(verifyEvent({ ...e, content: 'x' }), false);
  assert.equal(verifyEvent({ ...e, sig: e.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) }), false);
  assert.equal(verifyEvent({ ...e, created_at: e.created_at + 1 }), false);
  assert.equal(verifyEvent({ ...e, tags: [...e.tags, ['x', '1']] }), false);
  assert.equal(verifyEvent(null), false);
  assert.equal(verifyEvent({ ...e, tags: [[1]] }), false);
  assert.equal(toHexPubkey(npub(identity.nostrPubkey)), identity.nostrPubkey);
  assert.equal(toHexPubkey(identity.nostrPubkey.toUpperCase()), identity.nostrPubkey);
  assert.throws(() => toHexPubkey('nsec1qqqq'));
});

test('kind:10019 and the relay filter: our relays, mints with unit, the 02-prefixed P2PK key, never the identity key', () => {
  const id = { ...identity, relays: ['wss://relay.example'] };
  const t = nutzapInfoTemplate(id);
  assert.equal(t.kind, 10019);
  assert.deepEqual(t.tags, [['relay', 'wss://relay.example'], ['mint', MINT, 'sat'], ['pubkey', identity.p2pkPubkey]]);
  assert.match(identity.p2pkPubkey, /^02[0-9a-f]{64}$/);
  assert.notEqual(identity.p2pkPubkey.slice(2), identity.nostrPubkey);
  assert.deepEqual(nutzapFilter(id, 1000), { kinds: [9321], '#p': [identity.nostrPubkey], '#u': [MINT], since: 1000 });
});

test('parse: episode by guid, NIP-73 i tag or title; ts; message; boost or stream as Sovereigncast decides', () => {
  const parse = (o: Parameters<typeof nutzap>[0]) => {
    const r = parseNutzap(nutzap(o), identity, { podcastGuid: GUID, feed });
    assert.ok(r.ok, JSON.stringify(r));
    return r.nutzap;
  };
  let z = parse({ proofs: locked([16, 4, 1]), content: 'Danke!', tags: [['episode_guid', E301], ['ts', '61']] });
  assert.deepEqual([z.amountSat, z.episodeGuid, z.ts, z.message, z.kind, z.locked, z.mint], [21, E301, 61, 'Danke!', 'boost', true, MINT]);
  assert.equal(z.sender, publicKeyOf(senderSk));

  z = parse({ proofs: locked([4, 1]), tags: [['i', `podcast:item:guid:${E300}`], ['i', `podcast:guid:${GUID}`]] });
  assert.deepEqual([z.episodeGuid, z.kind, z.message], [E300, 'stream', '']);
  z = parse({ proofs: locked([64, 32, 4]) });
  assert.equal(z.kind, 'boost', '100 sats or more is a boost even without a message');
  z = parse({ proofs: locked([4]), tags: [['episode', E301_TITLE.toUpperCase()]] });
  assert.equal(z.episodeGuid, E301, 'exact title, case aside');
  z = parse({ proofs: locked([4]), tags: [['episode_guid', 'not-in-feed'], ['episode', 'Not a title']] });
  assert.deepEqual([z.episodeGuid, z.episodeTitle], [undefined, 'Not a title'], 'unknown episode: channel split');
  z = parse({ proofs: locked([4]), tags: [['episode', E301_TITLE]], content: `${E301_TITLE} · 00:12:34` });
  assert.deepEqual([z.kind, z.message], ['stream', ''], 'the player\'s head is not a message');
  z = parse({ proofs: locked([4]), tags: [['episode', E301_TITLE]], content: `${E301_TITLE} · 00:12:34 — Prost!` });
  assert.deepEqual([z.kind, z.message], ['boost', 'Prost!']);
  z = parse({ proofs: locked([4]), mint: MINT + '/' });
  assert.equal(z.mint, MINT, 'trailing slash normalised');
  // Unlocked proofs are taken (whoever swaps first owns them) but marked.
  z = parse({ proofs: FakeMint.proofs([2]) });
  assert.equal(z.locked, false);
});

test('listener message: Sovereigncast\'s cases', () => {
  assert.equal(listenerMessage('Folge 42 — Die Rückkehr · 00:01:02 — hallo', 'Folge 42 — Die Rückkehr'), 'hallo');
  assert.equal(listenerMessage('Folge 42 — Die Rückkehr', 'Folge 42 — Die Rückkehr'), '');
  assert.equal(listenerMessage('00:12:34'), '');
  assert.equal(listenerMessage('Gut — und schlecht'), 'Gut — und schlecht');
  assert.equal(listenerMessage('  '), '');
});

test('rejections never reach the mint: wrong p, mint, unit, lock, proofs, podcast', async () => {
  const ctx = setup();
  const otherKey = '02' + publicKeyOf(newSecretKey());
  const cases: Array<[string, NostrEvent]> = [
    ['not_for_us', nutzap({ proofs: locked([4]), p: publicKeyOf(newSecretKey()) })],
    ['untrusted_mint', nutzap({ proofs: locked([4]), mint: 'https://elsewhere.mint' })],
    ['unsupported_unit', nutzap({ proofs: locked([4]), unit: 'usd' })],
    ['wrong_lock', nutzap({ proofs: locked([4], otherKey) })],
    ['wrong_lock', nutzap({ proofs: [...locked([4]), ...locked([1], otherKey)] })],
    ['unsupported_lock', nutzap({ proofs: locked([4], identity.p2pkPubkey, [['pubkeys', otherKey], ['n_sigs', '2']]) })],
    ['unsupported_lock', nutzap({ proofs: FakeMint.proofs([4]).map((p) => ({ ...p, secret: createHTLCsecret('ab'.repeat(32)) })) })],
    ['invalid_proofs', nutzap({ proofs: [] })],
    ['invalid_proofs', nutzap({ proofs: locked([0]) })],
    ['invalid_proofs', nutzap({ proofs: locked(new Array(MAX_PROOFS_PER_EVENT + 1).fill(1)) })],
    ['invalid_proofs', nutzap({ proofs: [{ ...locked([1])[0], secret: 'x'.repeat(5000) }] })],
    ['other_podcast', nutzap({ proofs: locked([4]), tags: [['guid', 'another-podcast']] })],
    ['not_a_nutzap', signEvent({ kind: 1, content: 'hi', tags: [['p', identity.nostrPubkey]] }, senderSk)],
  ];
  for (const [reason, e] of cases) {
    const out = await processNutzap(ctx, e);
    assert.equal(out.state, 'rejected', reason);
    assert.match((out as { reason: string }).reason, new RegExp(`^${reason}`));
    assert.equal(ctx.ledger.nutzap(e.id)?.state, 'rejected');
  }
  // A proof tag that is not JSON
  const bad = signEvent({ kind: 9321, content: '', tags: [['proof', '{nope'], ['u', MINT], ['p', identity.nostrPubkey]] }, senderSk);
  assert.equal((await processNutzap(ctx, bad)).state, 'rejected');
  assert.deepEqual(ctx.mint.calls, [], 'the mint was never asked');
  assert.equal(ctx.ledger.credits(GUID).length, 0);
  // Rejected stays rejected: the same event again does nothing.
  assert.deepEqual(await processNutzap(ctx, cases[0][1]), { state: 'seen', eventId: cases[0][1].id, was: 'rejected' });
});

test('redeem: P2PK inputs signed with the nutzap key, booked to the episode split, books match the wallet', async () => {
  const ctx = setup();
  const e = nutzap({ proofs: locked([16, 4, 1]), content: 'Danke für die Folge!', tags: [['episode_guid', E301]] });
  const out = await processNutzap(ctx, e);
  assert.equal(out.state, 'redeemed');
  const credit = ctx.ledger.credits(GUID)[0];
  assert.deepEqual([credit.rail, credit.kind, credit.gross_msat, credit.episode_guid, credit.message, credit.sender],
    ['nip61', 'boost', 21_000, E301, 'Danke für die Folge!', npub(publicKeyOf(senderSk))]);
  const shares = ctx.ledger.balances(GUID).map((b) => [b.address, b.credited_msat]);
  assert.deepEqual(shares, [['nodesignal@getalby.com', 17_000], ['zettizettler@getalby.com', 4_000]]);
  assert.equal(ctx.ledger.nutzap(e.id)?.credit_id, credit.id);
  assert.ok(ctx.ledger.reconcile().ok);
  assert.equal(ctx.ledger.walletSat(MINT), 20, '21 in, 1 sat swap fee to the fee payer');

  // The fake mint really enforces the lock: without the key the swap is refused.
  const ctx2 = setup();
  const r = await receivePayment(ctx2, { mint: MINT, proofs: locked([4]), kind: 'boost', rail: 'nip61' });
  assert.deepEqual([r.status, r.body.success], [400, false]);
  const r2 = await receivePayment(ctx2, { mint: MINT, proofs: locked([4]), kind: 'boost', rail: 'nip61', privkey: newSecretKey() });
  assert.equal(r2.status, 400, 'a wrong key does not unlock');
});

test('exactly once: repeats, concurrent deliveries, a forged copy first, the same proofs in another event', async () => {
  const ctx = setup();
  const e = nutzap({ proofs: locked([4, 1]), tags: [['episode_guid', E301]] });

  // Someone republishes the event with a broken signature before the real one arrives.
  const forged = { ...e, sig: '00'.repeat(64) };
  assert.deepEqual(await processNutzap(ctx, forged), { state: 'ignored', eventId: e.id, reason: 'bad_event' });
  assert.equal(ctx.ledger.nutzap(e.id), undefined, 'a forged copy leaves no trace');

  const outs = await Promise.all([processNutzap(ctx, e), processNutzap(ctx, e), processNutzap(ctx, e)]);
  assert.deepEqual(outs.map((o) => o.state).sort(), ['redeemed', 'seen', 'seen']);
  assert.equal((await processNutzap(ctx, e)).state, 'seen');
  assert.equal(ctx.mint.calls.filter((c) => c === 'swap').length, 1);
  assert.equal(ctx.ledger.credits(GUID).length, 1);

  // Same proofs, wrapped in a new event (different id): the token hash stops it.
  const proofs = e.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]));
  const again = nutzap({ proofs, content: 'once more' });
  const out = await processNutzap(ctx, again);
  assert.equal(out.state, 'duplicate');
  assert.match(ctx.ledger.nutzap(again.id)!.reason!, /already booked as credit \d+/);
  assert.equal(ctx.ledger.credits(GUID).length, 1);
  assert.ok(ctx.ledger.reconcile().ok);
});

test('spent before we asked; mint down then retried with backoff; spent after an unanswered try is unknown', async () => {
  const ctx = setup();
  const taken = nutzap({ proofs: locked([8]) });
  for (const t of taken.tags) if (t[0] === 'proof') ctx.mint.spent.add(JSON.parse(t[1]).secret);
  assert.equal((await processNutzap(ctx, taken)).state, 'spent');

  const e = nutzap({ proofs: locked([8]), tags: [['episode_guid', E301]] });
  ctx.mint.down = true;
  assert.equal((await processNutzap(ctx, e)).state, 'retry');
  ctx.mint.down = false;
  assert.deepEqual(await retryNutzaps(ctx), [], 'not due yet');
  const [x] = await retryNutzaps(ctx, Date.now() + 61_000);
  assert.equal(x.state, 'redeemed');
  assert.equal(ctx.ledger.nutzap(e.id)!.attempts, 2);

  // The first try reached the mint but the answer was lost; the retry finds the proofs spent.
  const lost = nutzap({ proofs: locked([2]) });
  ctx.mint.down = true;
  await processNutzap(ctx, lost);
  ctx.mint.down = false;
  for (const t of lost.tags) if (t[0] === 'proof') ctx.mint.spent.add(JSON.parse(t[1]).secret);
  const [y] = await retryNutzaps(ctx, Date.now() + 61_000);
  assert.equal(y.state, 'unknown');
  const counts = ctx.ledger.nutzapCounts(GUID);
  assert.deepEqual([counts.redeemed, counts.spent, counts.unknown, counts.retry], [1, 1, 1, 0]);
});

test('recovery after a restart: an interrupted claim is retried, recognised as booked, or marked unknown', async () => {
  const ctx = setup();
  const seen = (e: NostrEvent) => ({ eventId: e.id, podcastGuid: GUID, sender: e.pubkey, createdAt: e.created_at, eventJson: JSON.stringify(e) });
  const proofsOf = (e: NostrEvent) => e.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]));

  const untouched = nutzap({ proofs: locked([4]) });
  ctx.ledger.claimNutzap(seen(untouched));

  const booked = nutzap({ proofs: locked([4]), tags: [['episode_guid', E301]] });
  ctx.ledger.claimNutzap(seen(booked));
  await receivePayment(ctx, { mint: MINT, proofs: proofsOf(booked), kind: 'stream', rail: 'nip61', privkey: p2pkSk });

  const swappedOnly = nutzap({ proofs: locked([2]) });
  ctx.ledger.claimNutzap(seen(swappedOnly));
  for (const p of proofsOf(swappedOnly)) ctx.mint.spent.add(p.secret);

  await recoverNutzaps(ctx);
  assert.equal(ctx.ledger.nutzap(untouched.id)!.state, 'retry');
  assert.equal(ctx.ledger.nutzap(booked.id)!.state, 'redeemed');
  assert.equal(ctx.ledger.nutzap(booked.id)!.credit_id, ctx.ledger.credits(GUID)[0].id);
  assert.equal(ctx.ledger.nutzap(swappedOnly.id)!.state, 'unknown');
  const [x] = await retryNutzaps(ctx, Date.now() + 120_000);
  assert.equal(x.state, 'redeemed');
});

test('relay loop: the NIP-61 filter, duplicates across relays, reconnect resumes from the cursor', async () => {
  const relayA = await startLocalRelay();
  const relayB = await startLocalRelay();
  const ctx = setup();
  ctx.identity = { ...identity, relays: [relayA.url, relayB.url] };
  const outcomes: string[] = [];
  const t0 = Math.floor(Date.now() / 1000);
  const first = nutzap({ proofs: locked([4, 1]), tags: [['episode_guid', E301]], created_at: t0 - 10 });
  // On both relays before we connect, plus two the relay filter keeps away from us.
  for (const r of [relayA, relayB]) r.publish(first);
  relayA.publish(nutzap({ proofs: locked([4]), p: publicKeyOf(newSecretKey()) }));
  relayA.publish(nutzap({ proofs: locked([4]), mint: 'https://elsewhere.mint' }));

  const intake = await startNutzapIntake(ctx, { onOutcome: (x) => outcomes.push(x.state) });
  const until = async (cond: () => boolean, ms = 5000) => {
    for (const end = Date.now() + ms; !cond(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error('timed out');
    await intake.idle();
  };
  await until(() => outcomes.length >= 1 && relayB.reqs.length >= 1);
  await intake.idle();
  assert.deepEqual(relayA.reqs[0].slice(1), [{ kinds: [9321], '#p': [identity.nostrPubkey], '#u': [MINT] }], 'first run: no since');
  assert.equal(ctx.ledger.credits(GUID).length, 1);
  assert.equal(ctx.ledger.getMeta(`nutzap_since:${GUID}`), String(t0 - 10));

  // A live event, then the relay drops us; on reconnect it asks from the cursor minus the slack.
  const second = nutzap({ proofs: locked([2]), created_at: t0 });
  relayA.publish(second);
  await until(() => ctx.ledger.credits(GUID).length === 2);
  relayA.kick();
  await until(() => relayA.reqs.length >= 2, 4000);
  assert.equal((relayA.reqs[1][1] as { since: number }).since, t0 - CURSOR_SLACK_S);
  await intake.idle();
  relayB.publish(second); // late copy on the other relay
  await new Promise((r) => setTimeout(r, 100));
  await intake.idle();
  assert.equal(ctx.ledger.credits(GUID).length, 2, 're-delivered events are not booked twice');
  assert.deepEqual(outcomes.filter((s) => s === 'redeemed').length, 2);
  intake.close();
  await relayA.close();
  await relayB.close();
});

test('the ledger shows each nutzap and what became of it', async () => {
  const ctx = setup();
  await processNutzap(ctx, nutzap({ proofs: locked([16, 4, 1]), content: 'Valido, ergo sum', tags: [['episode_guid', E301]] }));
  await processNutzap(ctx, nutzap({ proofs: locked([4], '02' + publicKeyOf(newSecretKey())) }));
  const data = ledgerJson(ctx.ledger, ctx.show);
  assert.deepEqual([data.nutzaps.counts.redeemed, data.nutzaps.counts.rejected], [1, 1]);
  assert.equal(data.credits[0].rail, 'nip61');
  assert.match(data.credits[0].sender!, /^npub1/);
  const rejected = data.nutzaps.recent.find((z) => z.state === 'rejected')!;
  assert.deepEqual([rejected.reason, rejected.credit_id, rejected.amount_sats], ['wrong_lock', null, 4]);
  const html = ledgerHtml(data);
  assert.match(html, /Nutzaps <span class="muted">\(NIP-61\)/);
  assert.match(html, /1 redeemed and booked above, 1 rejected/);
  assert.match(html, /wrong_lock/);
});

test('the nutzap key: created once with mode 0600, stable, and never the show\'s Nostr key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nutsplit-'));
  try {
    const a = loadNutzapKey(dir);
    assert.equal(statSync(join(dir, 'nutzap.secret')).mode & 0o777, 0o600);
    assert.deepEqual(loadNutzapKey(dir), a);
    assert.equal(a.pubkey, '02' + publicKeyOf(a.privkey));
    const z = nutzapIdentity({ nostrPubkey: npub(identity.nostrPubkey), relays: ['wss://r.example'], mints: [MINT + '/'], dataDir: dir });
    assert.deepEqual([z.identity.nostrPubkey, z.identity.mints, z.identity.p2pkPubkey], [identity.nostrPubkey, [MINT], a.pubkey]);
    assert.throws(() => nutzapIdentity({ nostrPubkey: a.pubkey.slice(2), relays: [], mints: [MINT], dataDir: dir }), /must not be the show's Nostr key/);
    assert.throws(() => nutzapIdentity({ nostrPubkey: identity.nostrPubkey, relays: ['https://r.example'], mints: [MINT], dataDir: dir }), /wss/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the capability document advertises nutzaps when they are on', async () => {
  const { createNutsplitServer } = await import('../src/server.ts');
  const ctx = setup();
  const z = { ...identity, relays: ['wss://relay.example'] };
  const server = createNutsplitServer({ ledger: ctx.ledger, shows: [ctx.show], mints: ctx.mints, nutzap: z });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cap = await (await fetch(`${base}/shows/${GUID}/ecash`)).json() as any;
  assert.deepEqual(cap.ecash.nutzap, { npub: npub(identity.nostrPubkey), p2pk_pubkey: identity.p2pkPubkey, relays: ['wss://relay.example'], mints: [MINT] });
  await new Promise((r) => server.close(r));
});

test('fixture: a real nutzap from testnut passes every NIP-61 check offline, DLEQ included', async () => {
  const { verifyMintSignatures } = await import('@cashu/cashu-ts');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/nutzap-testnut.json', import.meta.url), 'utf8'));
  const info = fx.kind10019 as NostrEvent;
  const e = fx.kind9321 as NostrEvent;
  assert.ok(verifyEvent(info) && verifyEvent(e));
  // The recipient's side, rebuilt from its kind:10019 alone.
  const tag = (name: string) => info.tags.filter((t) => t[0] === name).map((t) => t[1]);
  const id: NutzapIdentity = { nostrPubkey: info.pubkey, p2pkPubkey: tag('pubkey')[0], mints: tag('mint'), relays: tag('relay') };
  const r = parseNutzap(e, id, { podcastGuid: GUID, feed });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.nutzap.amountSat, r.nutzap.episodeGuid, r.nutzap.ts, r.nutzap.kind, r.nutzap.message, r.nutzap.locked, r.nutzap.mint],
    [21, E301, 2520, 'boost', 'Danke für die Folge!', true, 'https://testnut.cashu.space']);
  // DLEQ (NUT-12) against the mint's published keys: the mint really signed these.
  const keyset = () => ({ id: fx.keyset.id, keys: fx.keyset.keys });
  const v = await verifyMintSignatures(r.nutzap.proofs as any, keyset, { require: true });
  assert.deepEqual([v.valid.length, v.invalid.length], [3, 0]);
  const forgedC = r.nutzap.proofs.map((p, i) => (i ? p : { ...p, C: r.nutzap.proofs[1].C }));
  assert.equal((await verifyMintSignatures(forgedC as any, keyset, { require: true })).invalid.length, 1);
  // Someone else's 10019 key, another mint, a changed comment: each is caught.
  assert.deepEqual(parseNutzap(e, { ...id, p2pkPubkey: identity.p2pkPubkey }, { podcastGuid: GUID, feed }), { ok: false, reason: 'wrong_lock', detail: undefined });
  assert.equal((parseNutzap(e, { ...id, mints: [MINT] }, { podcastGuid: GUID, feed }) as { reason: string }).reason, 'untrusted_mint');
  assert.equal((parseNutzap({ ...e, content: 'Danke!' }, id, { podcastGuid: GUID, feed }) as { reason: string }).reason, 'bad_event');
});
