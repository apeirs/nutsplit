// Split math for podcast:value blocks.
//
// A port of Sovereigncast's `_split_recipients` and `_resolve_v4v_value`
// (podcast_manager/blueprints/community.py), so an instance and nutsplit agree
// on who gets what, plus Hopp's H-02 fix (fee recipients claiming 100 % or more
// together share the total by weight instead of overflowing it).
//
// Amounts are integers in whatever unit the caller picks: whole sats for a
// boost (Hopp ADR 0005: "21 sats at 80/20 are 17 + 4"), millisats for
// streaming accruals (ADR 0014: split to the millisat, pay whole sats, carry
// the rest). The parts always add up to exactly the amount.

export interface Recipient {
  name: string;
  /** `node`, `keysend` or `lnaddress`; may be empty in sloppy feeds. */
  type: string;
  address: string;
  /** Weight, or a percentage of the total when `fee` is set. */
  split: number;
  fee: boolean;
  customKey?: string;
  customValue?: string;
}

export interface RemoteItem {
  feedGuid: string;
  itemGuid?: string;
  feedUrl?: string;
  medium?: string;
}

export interface TimeSplit {
  startTime: number;
  duration: number;
  /** Share of the amount that goes to this split while it plays; spec default 100. */
  remotePercentage: number | null;
  remoteStartTime?: number;
  recipients: Recipient[];
  remoteItem?: RemoteItem;
}

export interface ValueBlock {
  type: string;
  method: string;
  suggested?: string;
  recipients: Recipient[];
  timeSplits: TimeSplit[];
}

export interface Share {
  recipient: Recipient;
  amount: number;
}

function weight(r: Recipient): number {
  const n = Math.trunc(Number(r.split));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Divide `amount` across the recipients of a value block.
 *
 * Value spec: a recipient with `fee` set takes its split as a percentage of
 * the total, off the top; the rest is divided among the others by weight.
 * Largest-remainder rounding, ties keep feed order. Recipients without an
 * address are not paid, shares that round to zero are dropped, and a block of
 * nothing but fee recipients is divided by weight.
 *
 * One deliberate difference from Sovereigncast: when fee recipients claim
 * 100 % or more between them, Sovereigncast hands each its percentage and the
 * parts can add up to more than the amount (two 60 % fees get 120 %). Here,
 * as in Hopp (audit H-02), they then share the total by weight.
 */
export function splitRecipients(recipients: readonly Recipient[], amount: number): Share[] {
  if (!Number.isSafeInteger(amount)) throw new RangeError(`amount must be a safe integer, got ${amount}`);
  const addr = recipients.filter((r) => (r.address ?? '').trim() !== '');
  if (amount <= 0) return [];
  const split = addr.map(weight);
  let isFee = addr.map((r) => Boolean(r.fee));
  const hasWeightedNonFee = split.some((w, i) => !isFee[i] && w > 0);
  const feePercent = split.reduce((s, w, i) => (isFee[i] ? s + Math.min(w, 100) : s), 0);
  if (!hasWeightedNonFee || feePercent >= 100) {
    // Fees only, or fees that leave nothing (or less than nothing) for the
    // rest: plain weights, among the fee recipients in the second case.
    if (hasWeightedNonFee) {
      const fees = isFee;
      for (let i = 0; i < split.length; i++) if (!fees[i]) split[i] = 0;
    }
    isFee = addr.map(() => false);
  }

  const amounts = addr.map(() => 0);
  for (let i = 0; i < addr.length; i++) {
    if (isFee[i]) amounts[i] = Math.floor((amount * Math.min(split[i], 100)) / 100);
  }
  const rest = Math.max(0, amount - amounts.reduce((a, b) => a + b, 0));

  const shares: number[] = [];
  for (let i = 0; i < addr.length; i++) if (!isFee[i] && split[i] > 0) shares.push(i);
  const totalW = shares.reduce((s, i) => s + split[i], 0);
  if (totalW > 0 && rest > 0) {
    for (const i of shares) amounts[i] = Math.floor((rest * split[i]) / totalW);
    const left = rest - shares.reduce((s, i) => s + amounts[i], 0);
    // Integer remainders, sorted descending; Array.prototype.sort is stable,
    // so equal remainders keep feed order, as Python's sorted(reverse=True).
    const order = [...shares].sort((a, b) => ((rest * split[b]) % totalW) - ((rest * split[a]) % totalW));
    for (let k = 0; k < left; k++) amounts[order[k % order.length]] += 1;
  }

  const out: Share[] = [];
  for (let i = 0; i < addr.length; i++) if (amounts[i] > 0) out.push({ recipient: addr[i], amount: amounts[i] });
  const total = out.reduce((s, x) => s + x.amount, 0);
  if (total > amount) throw new Error(`split overflow: ${total} > ${amount}`); // never, but never silently
  return out;
}

/** The time split active at playback position `ts` (seconds), if any. */
export function activeTimeSplit(block: ValueBlock, ts: number | null | undefined): TimeSplit | undefined {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return undefined;
  for (const s of block.timeSplits ?? []) {
    if (s.startTime === null || s.startTime === undefined) continue;
    if (s.startTime <= ts && ts < s.startTime + (s.duration || 0)) return s;
  }
  return undefined;
}

/**
 * Recipients and amounts for `amount` at playback position `ts`, honouring a
 * value-time-split: while one plays, `remotePercentage` % goes to its
 * recipients and the rest to the base block.
 *
 * A split that points at a `podcast:remoteItem` (music from another feed)
 * names no recipients itself. Sovereigncast then pays the base block, and so
 * does this unless `resolveRemote` returns the remote item's recipients.
 */
export function resolveValue(
  block: ValueBlock,
  ts: number | null | undefined,
  amount: number,
  resolveRemote?: (split: TimeSplit) => Recipient[] | undefined,
): Share[] {
  const base = block.recipients ?? [];
  const active = activeTimeSplit(block, ts);
  const remoteRecipients = active
    ? active.recipients?.length
      ? active.recipients
      : active.remoteItem && resolveRemote
        ? (resolveRemote(active) ?? [])
        : []
    : [];
  if (active && remoteRecipients.length) {
    const rp = active.remotePercentage === null || active.remotePercentage === undefined
      ? 100
      : Math.max(0, Math.min(100, Math.trunc(active.remotePercentage)));
    const remoteAmt = Math.floor((amount * rp) / 100);
    const baseAmt = amount - remoteAmt;
    return [...splitRecipients(base, baseAmt), ...splitRecipients(remoteRecipients, remoteAmt)];
  }
  return splitRecipients(base, amount);
}

const HEX66 = /^[0-9a-fA-F]{66}$/;

/** A recipient paid by keysend (a node pubkey). Same rule as `_v4v_is_keysend`. */
export function isKeysend(r: Pick<Recipient, 'type' | 'address'>): boolean {
  const t = (r.type ?? '').trim().toLowerCase();
  if (t === 'node' || t === 'keysend') return true;
  return HEX66.test((r.address ?? '').trim());
}

/** A Lightning address (LNURL-pay). Same rule as `_v4v_is_lnaddress`. */
export function isLnaddress(r: Pick<Recipient, 'type' | 'address'>): boolean {
  const a = (r.address ?? '').trim();
  return a.includes('@') && (r.type ?? '').trim().toLowerCase() !== 'node';
}

/**
 * The key a recipient's balance is kept under. Node recipients are keyed by
 * address *and* custom record, so sub-wallets on one node (Alby Hub, LNbits)
 * are not merged into one (Hopp audit M-05). A Lightning address identifies
 * its owner by itself; its customKey is only a callback hint and changes
 * between the channel and item blocks of the same feed.
 */
export function recipientKey(r: Recipient): string {
  const address = r.address.trim();
  if (isKeysend(r)) return `node:${address.toLowerCase()}:${r.customKey ?? ''}:${r.customValue ?? ''}`;
  if (isLnaddress(r)) return `lnaddress:${address.toLowerCase()}`;
  return `other:${r.type}:${address}`;
}
