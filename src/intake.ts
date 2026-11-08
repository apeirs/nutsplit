// Intake: take ecash a listener sends, swap it into the settler's wallet at
// once (so it cannot be spent twice), and book it to the episode's split.
// Errors mirror Sovereigncast's POST /api/community/ecash-payment
// (CASHU_STREAMING.md, "The answers"), so an app written for one works with
// the other.
import { createHash } from 'node:crypto';
import { bookReceipt, type Show } from './accrue.ts';
import { valueFor } from './feed.ts';
import type { CreditKind, Ledger } from './ledger.ts';
import type { MintClient } from './mint.ts';

export interface IntakeContext {
  ledger: Ledger;
  show: Show;
  /** Accepted mints, by URL without trailing slash. */
  mints: MintClient[];
}

export interface IncomingPayment {
  mint: string;
  unit?: string;
  proofs: Array<{ id: string; amount: number | string; secret: string; C: string; [k: string]: unknown }>;
  memo?: string;
  episodeGuid?: string;
  kind: CreditKind;
  ts?: number;
  sender?: string;
  rail: string;
  /** Signs P2PK-locked proofs at the swap (NIP-61 nutzaps); never sent anywhere. */
  privkey?: string;
}

export type IntakeResult =
  | { ok: true; status: 200; body: { success: true; amount_sats: number; mint_url: string; credit_id: number; episode_guid: string | null; value_source: string; shares: Array<{ name: string; address: string; msat: number }> } }
  | { ok: false; status: number; body: { success: false; error: string; message?: string; accepted_mints?: string[] } };

const MAX_PROOFS = 200;
const MAX_FIELD = 4096;

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): IntakeResult =>
  ({ ok: false, status, body: { success: false, error, ...extra } });

export function tokenHash(secrets: string[]): string {
  return createHash('sha256').update([...secrets].sort().join('\n')).digest('hex');
}

export async function receivePayment(ctx: IntakeContext, p: IncomingPayment): Promise<IntakeResult> {
  const mintUrl = String(p.mint ?? '').trim().replace(/\/+$/, '');
  if ((p.unit ?? 'sat').toLowerCase() !== 'sat') return fail(400, 'unsupported_unit');
  if (!mintUrl || !Array.isArray(p.proofs) || !p.proofs.length || p.proofs.length > MAX_PROOFS) return fail(400, 'invalid_payload');
  // Never shorten a field to fit: a truncated secret is still syntactically
  // valid and only fails at the mint (CASHU_STREAMING.md).
  for (const x of p.proofs) {
    const amount = Number(x?.amount);
    if (!x || typeof x.secret !== 'string' || typeof x.C !== 'string' || typeof x.id !== 'string'
      || !Number.isSafeInteger(amount) || amount <= 0
      || x.secret.length > MAX_FIELD || x.C.length > MAX_FIELD || x.id.length > 128) return fail(400, 'invalid_payload');
  }
  const mint = ctx.mints.find((m) => m.mintUrl === mintUrl);
  if (!mint) return fail(400, 'untrusted_mint', { accepted_mints: ctx.mints.map((m) => m.mintUrl) });
  const { block } = valueFor(ctx.show.feed, p.episodeGuid);
  if (!block) return fail(400, 'no_value_block', { message: 'the feed names no podcast:value recipients for this episode or the show' });

  const proofs = p.proofs.map((x) => ({ ...x, amount: Number(x.amount) }));
  const hash = tokenHash(proofs.map((x) => x.secret));
  if (ctx.ledger.hasToken(hash)) return fail(409, 'already_redeemed');
  const gross = proofs.reduce((s, x) => s + x.amount, 0);
  if (gross <= mint.feesForInputs(proofs)) return fail(400, 'amount_too_small');

  try {
    if ((await mint.invalidDleq(proofs as any)) > 0) return fail(400, 'invalid_payload', { message: 'DLEQ proof does not verify' });
  } catch {
    return fail(503, 'unavailable');
  }

  let fresh;
  try {
    fresh = await mint.receive(proofs as any, p.privkey ? { privkey: p.privkey } : undefined);
  } catch (e) {
    // No answer is not a refusal: the caller may hold the proofs and retry.
    if (mint.classifySwapError(e) === 'no_answer') return fail(503, 'unavailable');
    const text = String((e as Error)?.message ?? e).toLowerCase();
    if (text.includes('spent')) return fail(400, 'already_spent');
    if (text.includes('insufficient') || (text.includes('fee') && text.includes('reserve'))) return fail(400, 'amount_too_small');
    return fail(400, 'mint_error');
  }
  const net = fresh.reduce((s, x) => s + x.amount, 0);

  // The swap is done: book it and keep the proofs in one transaction.
  const booked = ctx.ledger.tx(() => {
    const r = bookReceipt(ctx.ledger, ctx.show, {
      episodeGuid: p.episodeGuid, kind: p.kind, grossMsat: gross * 1000, ts: p.ts, message: p.memo || undefined,
      sender: p.sender, rail: p.rail, mintUrl, tokenHash: hash, intakeFeeMsat: (gross - net) * 1000,
    });
    ctx.ledger.addProofs(mintUrl, fresh);
    return r;
  });
  return {
    ok: true, status: 200,
    body: {
      success: true, amount_sats: gross, mint_url: mintUrl, credit_id: booked.creditId,
      episode_guid: p.episodeGuid ?? null, value_source: booked.accrual.source,
      shares: booked.accrual.shares.map((s) => ({ name: s.recipient.name, address: s.recipient.address, msat: s.msat })),
    },
  };
}
