// Nutzap intake: take kind:9321 events from the show's relays, redeem each one
// exactly once, and book it through the same intake as a NUT-18 payment.
//
// Exactly once: an event id is claimed atomically in the ledger before the
// mint is asked, so the same event from three relays, or again after a
// restart, is redeemed once. Its proofs also pass the intake's token-hash
// check, so the same proofs in a second event (or a NUT-18 POST) are booked
// once. Only events whose signature checks out are written down: anyone can
// publish a copy of a nutzap with a broken signature, and that copy must not
// block the real one.
import { createHash } from 'node:crypto';
import { receivePayment, tokenHash, type IntakeContext } from './intake.ts';
import { npub, RelaySubscription, tagValues, type NostrEvent } from './nostr.ts';
import { DEFAULT_BOOST_THRESHOLD_SAT, nutzapFilter, parseNutzap, type NutzapIdentity } from './nutzap.ts';
import type { NutzapRow, NutzapSeen, NutzapState } from './ledger.ts';

export interface NutzapIntakeContext extends IntakeContext {
  identity: NutzapIdentity;
  /** Unlocks proofs locked to `identity.p2pkPubkey`. */
  p2pkPrivkey: string;
  boostThresholdSat?: number;
  log?: (line: string) => void;
}

export type NutzapOutcome =
  | { state: 'redeemed'; eventId: string; creditId: number; amountSat: number; kind: string }
  | { state: Exclude<NutzapState, 'redeemed'>; eventId: string; reason?: string }
  /** Already handled, or being handled: nothing done. */
  | { state: 'seen'; eventId: string; was: NutzapState }
  /** Not a genuine event: not written down. */
  | { state: 'ignored'; eventId?: string; reason: string };

/** Relays deliver late; on reconnect, ask again from this far before the newest event seen. */
export const CURSOR_SLACK_S = 3600;

const cursorKey = (podcastGuid: string) => `nutzap_since:${podcastGuid}`;

function seenOf(ctx: NutzapIntakeContext, e: NostrEvent, extra: Partial<NutzapSeen> = {}): NutzapSeen {
  return { eventId: e.id, podcastGuid: ctx.show.podcastGuid, sender: e.pubkey, createdAt: e.created_at, eventJson: JSON.stringify(e), ...extra };
}

/** What a rejected event's proof tags claim to carry, for the books; undefined if unreadable. */
function claimedAmount(e: NostrEvent): number | undefined {
  try {
    const n = tagValues(e, 'proof').reduce((s, p) => s + Number(JSON.parse(p).amount), 0);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The credit already booked for these proofs, if any. */
function creditFor(ctx: NutzapIntakeContext, secrets: string[]): number | undefined {
  const row = ctx.ledger.db.prepare('SELECT id FROM credits WHERE token_hash = ?').get(tokenHash(secrets)) as { id: number } | undefined;
  return row?.id;
}

/** Check one event and, if it is ours, redeem and book it. Never throws for a bad event. */
export async function processNutzap(ctx: NutzapIntakeContext, e: unknown): Promise<NutzapOutcome> {
  const check = parseNutzap(e, ctx.identity, ctx.show, ctx.boostThresholdSat ?? DEFAULT_BOOST_THRESHOLD_SAT);
  if (!check.ok && check.reason === 'bad_event') {
    const id = (e as { id?: unknown })?.id;
    return { state: 'ignored', eventId: typeof id === 'string' ? id.slice(0, 64) : undefined, reason: 'bad_event' };
  }
  const ev = e as NostrEvent;
  const before = ctx.ledger.nutzap(ev.id);
  if (before && before.state !== 'retry') return { state: 'seen', eventId: ev.id, was: before.state };
  if (!check.ok) {
    const reason = check.detail ? `${check.reason}: ${check.detail.slice(0, 120)}` : check.reason;
    if (before) ctx.ledger.finishNutzap(ev.id, 'rejected', { reason }); // a retry that no longer passes (config changed)
    else ctx.ledger.rejectNutzap(seenOf(ctx, ev, { amountSat: claimedAmount(ev) }), reason);
    return { state: 'rejected', eventId: ev.id, reason };
  }
  const z = check.nutzap;
  if (!ctx.ledger.claimNutzap(seenOf(ctx, ev, { mintUrl: z.mint, amountSat: z.amountSat, locked: z.locked }))) {
    return { state: 'seen', eventId: ev.id, was: ctx.ledger.nutzap(ev.id)?.state ?? 'claiming' };
  }
  const attempts = ctx.ledger.nutzap(ev.id)!.attempts;

  let r;
  try {
    r = await receivePayment(ctx, {
      mint: z.mint, unit: 'sat', proofs: z.proofs, memo: z.message || undefined, episodeGuid: z.episodeGuid,
      kind: z.kind, ts: z.ts, sender: npub(z.sender), rail: 'nip61', privkey: ctx.p2pkPrivkey,
    });
  } catch (err) {
    // The swap may have happened and the booking failed: the books must say so.
    const reason = `booking failed after the swap: ${(err as Error).message}`;
    ctx.ledger.finishNutzap(ev.id, 'unknown', { reason });
    return { state: 'unknown', eventId: ev.id, reason };
  }
  if (r.ok) {
    ctx.ledger.finishNutzap(ev.id, 'redeemed', { creditId: r.body.credit_id });
    return { state: 'redeemed', eventId: ev.id, creditId: r.body.credit_id, amountSat: r.body.amount_sats, kind: z.kind };
  }
  const code = r.body.error;
  if (code === 'already_redeemed') {
    const creditId = creditFor(ctx, z.proofs.map((p) => p.secret));
    ctx.ledger.finishNutzap(ev.id, 'duplicate', { reason: `proofs already booked${creditId ? ` as credit ${creditId}` : ''}` });
    return { state: 'duplicate', eventId: ev.id, reason: 'already_redeemed' };
  }
  if (code === 'already_spent') {
    // After an attempt that got no answer, "spent" may mean our own swap went through.
    if (attempts > 1) {
      const reason = 'spent after an unanswered attempt: possibly our swap; a NUT-09 restore would tell';
      ctx.ledger.finishNutzap(ev.id, 'unknown', { reason });
      return { state: 'unknown', eventId: ev.id, reason };
    }
    ctx.ledger.finishNutzap(ev.id, 'spent', { reason: 'already_spent' });
    return { state: 'spent', eventId: ev.id, reason: 'already_spent' };
  }
  if (code === 'unavailable') {
    ctx.ledger.finishNutzap(ev.id, 'retry', { reason: 'mint unavailable' });
    return { state: 'retry', eventId: ev.id, reason: 'unavailable' };
  }
  const reason = r.body.message ? `${code}: ${r.body.message}` : code;
  ctx.ledger.finishNutzap(ev.id, 'rejected', { reason });
  return { state: 'rejected', eventId: ev.id, reason };
}

/**
 * After a restart: an event left in `claiming` was being redeemed when the
 * process stopped. If its proofs are booked, it was redeemed; if they are
 * all unspent, the swap never happened and it is retried; otherwise the
 * swap may have happened without a booking, and it is marked `unknown`.
 */
export async function recoverNutzaps(ctx: NutzapIntakeContext): Promise<void> {
  for (const row of ctx.ledger.nutzapsIn('claiming', ctx.show.podcastGuid)) {
    const ev = JSON.parse(row.event_json) as NostrEvent;
    const check = parseNutzap(ev, ctx.identity, ctx.show, ctx.boostThresholdSat ?? DEFAULT_BOOST_THRESHOLD_SAT);
    if (!check.ok) { ctx.ledger.finishNutzap(row.event_id, 'rejected', { reason: check.reason }); continue; }
    const creditId = creditFor(ctx, check.nutzap.proofs.map((p) => p.secret));
    if (creditId) { ctx.ledger.finishNutzap(row.event_id, 'redeemed', { creditId }); continue; }
    const mint = ctx.mints.find((m) => m.mintUrl === check.nutzap.mint);
    try {
      const states = await mint!.checkProofStates(check.nutzap.proofs);
      if (states.every((s) => s === 'UNSPENT')) ctx.ledger.finishNutzap(row.event_id, 'retry', { reason: 'interrupted before the swap' });
      else ctx.ledger.finishNutzap(row.event_id, 'unknown', { reason: 'interrupted: proofs spent but not booked; a NUT-09 restore would tell' });
    } catch (err) {
      ctx.log?.(`nutzap ${row.event_id.slice(0, 12)}: recovery check failed, will look again: ${(err as Error).message}`);
    }
  }
}

/** Retry waits double per attempt: 1, 2, 4 … minutes, at most 6 hours. */
export function retryDue(row: Pick<NutzapRow, 'attempts' | 'updated_at'>, nowMs = Date.now()): boolean {
  const wait = Math.min(60_000 * 2 ** Math.max(0, row.attempts - 1), 6 * 3600_000);
  return nowMs - Date.parse(row.updated_at) >= wait;
}

export async function retryNutzaps(ctx: NutzapIntakeContext, nowMs = Date.now()): Promise<NutzapOutcome[]> {
  const out: NutzapOutcome[] = [];
  for (const row of ctx.ledger.nutzapsIn('retry', ctx.show.podcastGuid)) {
    if (retryDue(row, nowMs)) out.push(await processNutzap(ctx, JSON.parse(row.event_json)));
  }
  return out;
}

export interface NutzapIntake {
  /** Resolves once every event received so far has been processed. */
  idle(): Promise<void>;
  close(): void;
}

/**
 * Subscribe to the show's relays (NIP-61 filter: kind 9321, #p us, #u our
 * mints, since the newest event seen minus an hour) and process events one at
 * a time, in arrival order. Events still waiting on the mint are retried
 * every `retryEveryMs`.
 */
export async function startNutzapIntake(ctx: NutzapIntakeContext, o: { retryEveryMs?: number; onOutcome?: (x: NutzapOutcome) => void } = {}): Promise<NutzapIntake> {
  await recoverNutzaps(ctx);
  const key = cursorKey(ctx.show.podcastGuid);
  const stored = Number(ctx.ledger.getMeta(key));
  let cursor = Number.isSafeInteger(stored) && stored > 0 ? stored : undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const queued = new Set<string>();
  const report = (x: NutzapOutcome) => {
    o.onOutcome?.(x);
    if (x.state !== 'seen') ctx.log?.(`nutzap ${(x.eventId ?? '?').slice(0, 12)} ${x.state}${'amountSat' in x ? ` ${x.amountSat} sat ${x.kind}` : ''}${'reason' in x && x.reason ? ` (${x.reason})` : ''}`);
  };
  const run = (job: () => Promise<void>) => {
    chain = chain.then(job).catch((err) => ctx.log?.(`nutzap intake: ${(err as Error).message}`));
  };

  const onEvent = (e: NostrEvent) => {
    const id = typeof e?.id === 'string' ? e.id : createHash('sha256').update(JSON.stringify(e)).digest('hex');
    if (queued.has(id)) return;
    queued.add(id);
    run(async () => {
      try {
        const x = await processNutzap(ctx, e);
        report(x);
        if (x.state !== 'ignored' && Number.isSafeInteger(e.created_at) && (cursor === undefined || e.created_at > cursor)) {
          cursor = e.created_at;
          ctx.ledger.setMeta(key, String(cursor));
        }
      } finally {
        queued.delete(id);
      }
    });
  };

  const subs = ctx.identity.relays.map((url) => new RelaySubscription(url, {
    filters: () => [nutzapFilter(ctx.identity, cursor === undefined ? undefined : Math.max(0, cursor - CURSOR_SLACK_S))],
    onEvent, log: ctx.log,
  }).start());
  const timer = setInterval(() => run(async () => { for (const x of await retryNutzaps(ctx)) report(x); }), o.retryEveryMs ?? 60_000);
  timer.unref();

  return {
    idle: async () => {
      let seen: Promise<unknown>;
      do { seen = chain; await seen; } while (seen !== chain);
    },
    close: () => {
      clearInterval(timer);
      for (const s of subs) s.close();
    },
  };
}
