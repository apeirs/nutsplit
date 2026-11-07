// Accrual: turn a credit into per-recipient shares, the way the show's feed
// says, and book it.
import { valueFor, type Feed } from './feed.ts';
import { resolveValue, type Recipient, type TimeSplit } from './split.ts';
import type { CreditInput, CreditKind, Ledger, ShareMsat } from './ledger.ts';

/** Who carries the cost of moving the money (mint swap and melt fees). */
export type FeePolicy = 'show' | 'recipient';

export interface Show {
  podcastGuid: string;
  feed: Feed;
  /**
   * `show` (default): fees come out of the show's own balance, so every other
   * recipient gets exactly their share of what listeners sent. `recipient`:
   * each payout's fee comes out of that payout's recipient, and the intake
   * fee is shared by everyone.
   */
  feePolicy: FeePolicy;
  /** The show's own recipient; defaults to the channel block's first one. */
  feePayer?: Recipient;
  resolveRemote?: (split: TimeSplit) => Recipient[] | undefined;
}

export function defaultFeePayer(feed: Feed): Recipient | undefined {
  const pick = (rs?: Recipient[]) => rs?.find((r) => r.address && !r.fee && r.split > 0);
  return pick(feed.value?.recipients) ?? pick(feed.items.find((i) => i.value)?.value?.recipients);
}

export function feePayerOf(show: Show): Recipient | undefined {
  return show.feePolicy === 'show' ? (show.feePayer ?? defaultFeePayer(show.feed)) : undefined;
}

export interface Accrual {
  shares: ShareMsat[];
  source: 'item' | 'channel' | 'none';
  episodeTitle?: string;
  splitMsat: number;
}

/**
 * Shares for `amountMsat` of `kind` on an episode at position `ts`.
 * A boost is split in whole sats (Hopp ADR 0005: 21 sats at 80/20 are
 * 17 + 4); streaming is split to the millisat and the rest carries in each
 * recipient's balance (ADR 0014).
 */
export function accrue(show: Show, episodeGuid: string | undefined, kind: CreditKind, amountMsat: number, ts?: number): Accrual {
  const { block, item, source } = valueFor(show.feed, episodeGuid);
  if (!block) return { shares: [], source, episodeTitle: item?.title, splitMsat: amountMsat };
  let shares: ShareMsat[];
  if (kind === 'boost' && amountMsat % 1000 === 0) {
    shares = resolveValue(block, ts, amountMsat / 1000, show.resolveRemote)
      .map((s) => ({ recipient: s.recipient, msat: s.amount * 1000 }));
  } else {
    shares = resolveValue(block, ts, amountMsat, show.resolveRemote).map((s) => ({ recipient: s.recipient, msat: s.amount }));
  }
  return { shares, source, episodeTitle: item?.title, splitMsat: amountMsat };
}

/** Book a received payment: split it and write the credit with its shares. */
export function bookReceipt(ledger: Ledger, show: Show, c: Omit<CreditInput, 'podcastGuid' | 'valueSource'> & { intakeFeeMsat: number }): { creditId: number; accrual: Accrual } {
  const feePayer = feePayerOf(show);
  const toSplit = feePayer ? c.grossMsat : c.grossMsat - c.intakeFeeMsat;
  const accrual = accrue(show, c.episodeGuid, c.kind, toSplit, c.ts);
  if (!accrual.shares.length) throw new Error('no_value_block');
  const { intakeFeeMsat, ...rest } = c;
  const creditId = ledger.bookCredit({
    ...rest, podcastGuid: show.podcastGuid, episodeTitle: c.episodeTitle ?? accrual.episodeTitle, valueSource: accrual.source,
  }, accrual.shares, intakeFeeMsat, feePayer);
  return { creditId, accrual };
}
