// Settlement: pay each recipient what it is owed, in batches, by melting the
// settler's ecash to the recipient's Lightning address.
//
// The rules, as Hopp states them (ADR 0005, audits of 2026-10):
//   - whole sats only; parts of a sat stay owed and carry to the next batch;
//   - fees never come out of another recipient's share (see FeePolicy);
//   - a share that cannot be paid is skipped and shown, never redistributed;
//   - the payout is journalled before the mint is asked to pay;
//   - an unknown outcome is never paid again: only the mint's answer
//     (NUT-05 quote state, NUT-07 proof state) settles it.
import { feePayerOf, type Show } from './accrue.ts';
import { lnurlInvoice, type LnurlDeps } from './lnurl.ts';
import { isKeysend, isLnaddress, recipientKey, type Recipient } from './split.ts';
import type { Ledger, PayoutRow, RecipientBalance } from './ledger.ts';
import type { MintClient } from './mint.ts';

/** Pays a node recipient by keysend (an NWC wallet with pay_keysend). Not built yet. */
export interface KeysendPayer {
  name: string;
}

export interface SettleContext {
  ledger: Ledger;
  show: Show;
  mints: MintClient[];
  lnurl?: LnurlDeps;
  /** A recipient is paid once it is owed at least this many whole sats. */
  thresholdSat: number;
  /** Public URL of this nutsplit instance: turns the comment into `rss::payment::<action> <url> <msg>`. */
  publicUrl?: string;
  /** LUD-18 payer name. */
  senderName?: string;
  keysend?: KeysendPayer;
  /** An unanswered melt is only declared failed after this long (default 10 min). */
  graceMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PayoutReport {
  recipient: string;
  name: string;
  amountSat: number;
  outcome: 'sent' | 'unknown' | 'failed' | 'skipped' | 'waiting';
  feeSat?: number;
  reason?: string;
  payoutId?: number;
  memoCarried?: boolean;
}

export interface SettleReport {
  resolved: Array<{ payoutId: number; state: string; note: string }>;
  payouts: PayoutReport[];
}

const MIN_PAYOUT_SAT = 1;


function describe(b: Pick<RecipientBalance, 'name' | 'address'>): string {
  return b.name && b.name !== b.address ? `${b.name} <${b.address}>` : b.address;
}

/** The LUD-12 comment for a batch: which episodes, how many boosts, their messages. */
export function batchComment(ledger: Ledger, ctx: Pick<SettleContext, 'show' | 'publicUrl'>, recipientKey: string, sinceEntryId: number): string {
  const rows = ledger.db.prepare(`SELECT c.kind, c.message, c.episode_title FROM entries e JOIN credits c ON c.id = e.credit_id
      WHERE e.podcast_guid = ? AND e.recipient_key = ? AND e.kind = 'share' AND e.id > ? ORDER BY e.id`)
    .all(ctx.show.podcastGuid, recipientKey, sinceEntryId) as Array<{ kind: string; message: string | null; episode_title: string | null }>;
  const boosts = rows.filter((r) => r.kind === 'boost');
  const streams = rows.length - boosts.length;
  const episodes = new Set(rows.map((r) => (r.episode_title ?? '').match(/\bE\d+\b/)?.[0] ?? r.episode_title ?? '').filter(Boolean));
  const msgs = boosts.map((b) => b.message).filter(Boolean).map((m) => `"${m}"`);
  const parts = [
    `${ctx.show.feed.title.split(' - ')[0]}`,
    episodes.size ? [...episodes].slice(0, 3).join(', ') + (episodes.size > 3 ? ` +${episodes.size - 3}` : '') : '',
    [boosts.length ? `${boosts.length} boost${boosts.length > 1 ? 's' : ''}` : '', streams ? `${streams} stream payment${streams > 1 ? 's' : ''}` : '']
      .filter(Boolean).join(', '),
    msgs.join(' '),
  ].filter(Boolean);
  if (!rows.length) parts.push('remainder of earlier payments');
  const text = `nutsplit: ${parts.join(' · ')}`;
  if (!ctx.publicUrl) return text;
  const action = boosts.length ? 'boost' : 'stream';
  const url = `${ctx.publicUrl.replace(/\/+$/, '')}/ledger/${ctx.show.podcastGuid}`;
  return `rss::payment::${action} ${url} ${text}`;
}

/** Settle payouts left `unknown` by a crash or an unanswered melt, from the mint's own records. */
export async function resolveUnknown(ctx: SettleContext): Promise<SettleReport['resolved']> {
  const out: SettleReport['resolved'] = [];
  const now = ctx.now ?? Date.now;
  for (const p of ctx.ledger.payouts(ctx.show.podcastGuid, 'unknown')) {
    const mint = ctx.mints.find((m) => m.mintUrl === p.mint_url);
    if (!mint || !p.melt_quote) {
      out.push({ payoutId: p.id, state: 'unknown', note: 'mint not configured' });
      continue;
    }
    out.push({ payoutId: p.id, ...(await resolveOne(ctx, mint, p, now() - Date.parse(p.updated_at) >= (ctx.graceMs ?? 600_000))) });
  }
  return out;
}

async function resolveOne(ctx: SettleContext, mint: MintClient, p: PayoutRow, graceOver: boolean): Promise<{ state: string; note: string }> {
  const feePayer = feePayerOf(ctx.show) ?? null;
  let q;
  try {
    q = await mint.checkMeltQuote(p.melt_quote!);
  } catch (e) {
    ctx.ledger.noteUnknown(p.id, `quote check failed: ${(e as Error).message}`);
    return { state: 'unknown', note: 'mint unreachable' };
  }
  if (q.state === 'PAID') {
    let change: Awaited<ReturnType<MintClient['changeFromSignatures']>> = [];
    try {
      change = await mint.changeFromSignatures(p.output_data_json ?? '[]', q.changeSigs);
    } catch (e) {
      ctx.log?.(`payout ${p.id}: paid, change not recoverable (${(e as Error).message})`);
    }
    ctx.ledger.settleSent(p.id, { preimage: q.preimage, change, feePayer });
    return { state: 'sent', note: 'mint reports PAID' };
  }
  if (q.state === 'PENDING') {
    ctx.ledger.noteUnknown(p.id, 'mint reports the payment PENDING');
    return { state: 'unknown', note: 'PENDING' };
  }
  // UNPAID: failed only if every input is provably unspent.
  const inputs = JSON.parse(p.inputs_json ?? '[]');
  let states: string[];
  try {
    states = await mint.checkProofStates(inputs);
  } catch (e) {
    ctx.ledger.noteUnknown(p.id, `proof state check failed: ${(e as Error).message}`);
    return { state: 'unknown', note: 'mint unreachable' };
  }
  if (!states.every((s) => s === 'UNSPENT')) {
    ctx.ledger.noteUnknown(p.id, `quote UNPAID but inputs ${[...new Set(states)].join('/')}`);
    return { state: 'unknown', note: 'inputs not unspent' };
  }
  const answered = (p.error ?? '').startsWith('mint answered');
  if (answered) {
    ctx.ledger.settleFailed(p.id, p.error ?? 'quote UNPAID, inputs unspent');
    return { state: 'failed', note: 'mint refused the melt; inputs released' };
  }
  if (!graceOver) return { state: 'unknown', note: 'no answer yet, waiting out the grace period' };
  // No answer from the mint, ever: swap the inputs first so a melt request
  // still on its way cannot spend them, then release the amount.
  try {
    const fresh = await mint.receive(inputs);
    ctx.ledger.settleFailed(p.id, 'no answer; quote UNPAID, inputs unspent and swapped', { fresh, feePayer });
    return { state: 'failed', note: 'inputs swapped and released' };
  } catch (e) {
    ctx.ledger.noteUnknown(p.id, `release swap failed: ${(e as Error).message}`);
    return { state: 'unknown', note: 'release swap failed' };
  }
}

/**
 * One settlement pass: resolve unknown outcomes, then pay every recipient
 * owed at least the threshold (or, with `force`, at least one whole sat:
 * the daily or episode-end cutoff).
 */
export async function settle(ctx: SettleContext, opts: { force?: boolean } = {}): Promise<SettleReport> {
  const resolved = await resolveUnknown(ctx);
  const payouts: PayoutReport[] = [];
  const guid = ctx.show.podcastGuid;
  const feePayer = feePayerOf(ctx.show) ?? null;
  const payerKey = feePayer ? recipientKey(feePayer) : undefined;
  const min = opts.force ? MIN_PAYOUT_SAT : Math.max(ctx.thresholdSat, MIN_PAYOUT_SAT);
  // The fee payer goes last: the other recipients' fees are charged to it.
  const order = ctx.ledger.balances(guid).sort((x, y) => Number(x.key === payerKey) - Number(y.key === payerKey));
  for (const b of order) {
    // Re-read: payouts earlier in this pass charged their fees to the fee payer.
    b.owed_msat = ctx.ledger.owedMsat(guid, b.key);
    const owedSat = Math.floor(b.owed_msat / 1000);
    const base = { recipient: b.key, name: describe(b), amountSat: owedSat };
    if (owedSat < min) {
      if (b.owed_msat > 0) payouts.push({ ...base, outcome: 'waiting', reason: `owed ${b.owed_msat} msat, below ${min} sat` });
      continue;
    }
    const rec = ctx.ledger.recipient(b.key)!;
    if (isKeysend(rec)) {
      // A mint cannot keysend (Hopp ADR 0005: "keysend is the constraint, not the wallet").
      const reason = ctx.keysend
        ? 'keysend via NWC is not built yet'
        : 'unpayable by mint: keysend recipient, needs an NWC wallet with pay_keysend';
      ctx.ledger.recordSkip(guid, b.key, owedSat * 1000, 'keysend', reason);
      payouts.push({ ...base, outcome: 'skipped', reason });
      continue;
    }
    if (!isLnaddress(rec)) {
      const reason = 'no payment method for this recipient type';
      ctx.ledger.recordSkip(guid, b.key, owedSat * 1000, rec.type || 'other', reason);
      payouts.push({ ...base, outcome: 'skipped', reason });
      continue;
    }
    // Whoever carries their own fee (the fee payer; everyone under the
    // `recipient` policy) is paid their balance minus what the payout may
    // cost; what the fee does not use stays owed and goes with the next batch.
    const selfFunded = ctx.show.feePolicy === 'recipient' || b.key === payerKey;
    const payerOwedSat = selfFunded ? owedSat : Math.floor(ctx.ledger.owedMsat(guid, payerKey!) / 1000);
    // The fee payer keeps a float for the fees of everyone still owed, so a
    // guest paid after the show is not held up by the show's empty balance.
    const floatSat = b.key === payerKey && ctx.show.feePolicy === 'show'
      ? feeFloatSat(ctx.ledger.balances(guid).filter((x) => x.key !== payerKey), ctx.thresholdSat)
      : 0;
    payouts.push(await payLnaddress(ctx, b, rec.address, owedSat - floatSat, selfFunded, payerOwedSat, feePayer));
  }
  return { resolved, payouts };
}

/**
 * What the fee payer keeps back for the other recipients' coming payouts:
 * per Lightning-address recipient still owed, the reserve the measured mints
 * ask (max(2 sat, 1 %) of what it will be paid) plus 2 sat of input fees.
 */
export function feeFloatSat(others: RecipientBalance[], thresholdSat: number): number {
  let sum = 0;
  for (const o of others) {
    if (o.owed_msat <= 0 || isKeysend(o) || !isLnaddress(o)) continue;
    const expected = Math.max(Math.floor(o.owed_msat / 1000), thresholdSat);
    sum += Math.max(2, Math.ceil(expected / 100)) + 2;
  }
  return sum;
}

/** The mint holding the most for this payout. */
function pickMint(ctx: SettleContext): MintClient | undefined {
  const balances = new Map(ctx.ledger.mintBalances().map((m) => [m.mint_url, m.sat]));
  return [...ctx.mints].sort((x, y) => (balances.get(y.mintUrl) ?? 0) - (balances.get(x.mintUrl) ?? 0))[0];
}

async function payLnaddress(ctx: SettleContext, b: RecipientBalance, address: string, owedSat: number,
  selfFunded: boolean, payerOwedSat: number, feePayer: Recipient | null): Promise<PayoutReport> {
  const guid = ctx.show.podcastGuid;
  const mint = pickMint(ctx);
  let amountSat = owedSat;
  const skip = (reason: string): PayoutReport => {
    ctx.ledger.recordSkip(guid, b.key, owedSat * 1000, 'lnaddress', reason);
    ctx.log?.(`skip ${describe(b)} ${amountSat} sat: ${reason}`);
    return { recipient: b.key, name: describe(b), amountSat, outcome: 'skipped', reason };
  };
  if (!mint) return skip('no mint configured');
  const unspent = () => ctx.ledger.unspentProofs(mint.mintUrl);
  if (selfFunded) {
    // First guess at the cost: the reserve the measured mints ask
    // (max(2 sat, 1 %)) plus the input fee of the proofs it would take.
    // Found offline, by a few rounds of proof selection.
    const reserveGuess = Math.max(2, Math.ceil(owedSat / 100));
    let inputFee = 0;
    for (let i = 0; i < 6; i++) {
      amountSat = owedSat - reserveGuess - inputFee;
      const sel = mint.selectToSend(unspent(), amountSat + reserveGuess);
      const f = sel.send.length ? mint.feesForInputs(sel.send) : inputFee + 1;
      if (sel.send.length && f <= inputFee) break;
      inputFee = f;
    }
  }

  const lastSent = ctx.ledger.db.prepare(`SELECT COALESCE(MAX(covers_entry_max), 0) AS m FROM payouts
    WHERE podcast_guid = ? AND recipient_key = ? AND state IN ('sent','unknown')`).get(guid, b.key) as { m: number };
  const comment = batchComment(ctx.ledger, ctx, b.key, lastSent.m);

  // At most two rounds: a self-funded payout whose real reserve is above the
  // guess is asked for again, smaller by the difference.
  let inv, quote, send;
  for (let round = 0; ; round++) {
    if (amountSat < MIN_PAYOUT_SAT) return skip(`balance of ${owedSat} sat does not cover the payout fee`);
    inv = await lnurlInvoice(address, amountSat, comment, ctx.senderName ?? ctx.show.feed.title, ctx.lnurl);
    if (!inv.invoice) return skip(inv.error ?? 'no invoice');
    try {
      quote = await mint.createMeltQuote(inv.invoice);
    } catch (e) {
      return skip(`melt quote failed: ${(e as Error).message}`);
    }
    if (quote.unit !== 'sat' || quote.amountSat !== amountSat) {
      return skip(`melt quote is for ${quote.amountSat} ${quote.unit}, not the share of ${amountSat} sat`);
    }
    ({ send } = mint.selectToSend(unspent(), amountSat + quote.feeReserveSat));
    if (!send.length) return skip(`wallet short: ${amountSat} + ${quote.feeReserveSat} sat reserve not available at ${mint.mintUrl}`);
    // Worst case: the whole Lightning reserve plus the input fee. It has to
    // fit the balance that carries it, so no share ever pays another's fee.
    const worstFeeSat = quote.feeReserveSat + mint.feesForInputs(send);
    const budget = selfFunded ? owedSat - amountSat : payerOwedSat;
    if (worstFeeSat <= budget) break;
    if (!selfFunded || round >= 1) return skip(`fee up to ${worstFeeSat} sat exceeds the ${budget} sat the fee payer's balance covers`);
    amountSat -= worstFeeSat - budget;
  }
  const base = { recipient: b.key, name: describe(b), amountSat };

  let prepared;
  try {
    prepared = await mint.prepareMelt(quote, send);
  } catch (e) {
    return skip(`could not prepare melt: ${(e as Error).message}`);
  }
  // Journal first: from here on a crash leaves an 'unknown' row, never a silent gap.
  const payoutId = ctx.ledger.journalPayout({
    podcastGuid: guid, recipientKey: b.key, amountMsat: amountSat * 1000, rail: 'lnaddress', mintUrl: mint.mintUrl,
    invoice: inv.invoice, paymentHash: inv.paymentHash, meltQuote: quote.quote, feeReserveSat: quote.feeReserveSat,
    inputs: send, outputDataJson: prepared.outputDataJson, comment, memoCarried: inv.memoCarried,
  });
  ctx.log?.(`pay ${describe(b)} ${amountSat} sat (payout ${payoutId}, reserve ${quote.feeReserveSat})`);

  try {
    const r = await mint.completeMelt(prepared.preview);
    if (r.state === 'PAID') {
      ctx.ledger.settleSent(payoutId, { preimage: r.preimage, change: r.change, feePayer });
      const fee = ctx.ledger.payout(payoutId)!.fee_msat! / 1000;
      return { ...base, outcome: 'sent', feeSat: fee, payoutId, memoCarried: inv.memoCarried };
    }
    ctx.ledger.noteUnknown(payoutId, `mint reports ${r.state}`);
    return { ...base, outcome: 'unknown', reason: `mint reports ${r.state}`, payoutId };
  } catch (e) {
    const kind = mint.classifyMeltError(e);
    const msg = (e as Error).message;
    if (kind === 'mint_answered') {
      ctx.ledger.noteUnknown(payoutId, `mint answered: ${msg}`);
      const res = await resolveOne(ctx, mint, ctx.ledger.payout(payoutId)!, false);
      return { ...base, outcome: res.state as PayoutReport['outcome'], reason: msg, payoutId };
    }
    if (kind === 'paid_change_lost') {
      const res = await resolveOne(ctx, mint, ctx.ledger.payout(payoutId)!, false);
      return { ...base, outcome: res.state as PayoutReport['outcome'], reason: `paid; ${msg}`, payoutId };
    }
    ctx.ledger.noteUnknown(payoutId, `no answer: ${msg}`);
    return { ...base, outcome: 'unknown', reason: `no answer from the mint: ${msg}`, payoutId };
  }
}
