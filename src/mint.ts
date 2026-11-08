// The settler's view of a mint: the handful of operations nutsplit needs,
// behind an interface so the settlement logic can be tested against a fake
// mint, and a cashu-ts 4.13 implementation of it.
import {
  Wallet, OutputData, MeltQuoteState, MintOperationError, HttpResponseError, MeltChangeError, NetworkError,
  deserializeProofs, serializeProofs, type Proof, type ProofLike, type CounterSource, type CounterRange,
} from '@cashu/cashu-ts';
import type { Ledger, StoredProof } from './ledger.ts';

export type MeltState = 'UNPAID' | 'PENDING' | 'PAID';

export interface MeltQuote {
  quote: string;
  amountSat: number;
  feeReserveSat: number;
  unit: string;
  state: MeltState;
  request?: string;
}

export interface MeltOutcome {
  state: MeltState;
  preimage: string | null;
  change: StoredProof[];
}

/** Why a melt call threw: the mint answered (definitive), or we cannot know. */
export type MeltErrorKind = 'mint_answered' | 'paid_change_lost' | 'no_answer';

export interface MintClient {
  readonly mintUrl: string;
  load(): Promise<void>;
  createMeltQuote(invoice: string): Promise<MeltQuote>;
  checkMeltQuote(quote: string): Promise<{ state: MeltState; preimage: string | null; changeSigs: unknown[] }>;
  /** Offline proof selection covering `amountSat` plus input fees. Empty `send` if short. */
  selectToSend(proofs: StoredProof[], amountSat: number): { send: StoredProof[]; keep: StoredProof[] };
  prepareMelt(quote: MeltQuote, inputs: StoredProof[]): Promise<{ preview: unknown; outputDataJson: string }>;
  completeMelt(preview: unknown): Promise<MeltOutcome>;
  changeFromSignatures(outputDataJson: string, sigs: unknown[]): Promise<StoredProof[]>;
  checkProofStates(proofs: StoredProof[]): Promise<Array<'UNSPENT' | 'PENDING' | 'SPENT'>>;
  /** Swap incoming (or our own) proofs for fresh ones; `privkey` signs P2PK-locked inputs (NUT-11). */
  receive(proofs: ProofLike[], opts?: { privkey?: string }): Promise<StoredProof[]>;
  /** NUT-12: count of proofs whose DLEQ does not verify (proofs without one pass). */
  invalidDleq(proofs: ProofLike[]): Promise<number>;
  feesForInputs(proofs: Array<{ id: string }>): number;
  classifyMeltError(e: unknown): MeltErrorKind;
  /** A failed swap: the mint refused (or we never got as far as asking), or it could not be reached. */
  classifySwapError(e: unknown): 'mint_answered' | 'no_answer';
}

export function toStored(proofs: Proof[]): StoredProof[] {
  return serializeProofs(proofs).map((s) => JSON.parse(s));
}

export function toProofs(proofs: StoredProof[]): Proof[] {
  return deserializeProofs(proofs as unknown as ProofLike[]);
}

/** NUT-13 counters kept in the ledger, so deterministic secrets never repeat across restarts. */
export class LedgerCounterSource implements CounterSource {
  private readonly ledger: Ledger;
  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }
  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    const start = this.ledger.counterNext(keysetId);
    if (n > 0) this.ledger.counterSet(keysetId, start + n);
    return { start, count: n };
  }
  async reserveAt(keysetId: string, start: number, count: number): Promise<CounterRange> {
    if (start < this.ledger.counterNext(keysetId)) throw new Error('counter range already issued');
    this.ledger.counterSet(keysetId, start + count);
    return { start, count };
  }
  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    this.ledger.counterSet(keysetId, minNext);
  }
  async snapshot(): Promise<Record<string, number>> {
    const rows = this.ledger.db.prepare('SELECT keyset_id, next FROM counters').all() as Array<{ keyset_id: string; next: number }>;
    return Object.fromEntries(rows.map((r) => [r.keyset_id, r.next]));
  }
  async setNext(keysetId: string, next: number): Promise<void> {
    this.ledger.counterSet(keysetId, next);
  }
}

export class CashuMint implements MintClient {
  readonly mintUrl: string;
  readonly wallet: Wallet;

  constructor(mintUrl: string, opts: { seed: Uint8Array; ledger: Ledger; requestTimeoutMs?: number }) {
    this.mintUrl = mintUrl.replace(/\/+$/, '');
    this.wallet = new Wallet(this.mintUrl, {
      unit: 'sat',
      bip39seed: opts.seed,
      counterSource: new LedgerCounterSource(opts.ledger),
    });
  }

  async load(): Promise<void> {
    await this.wallet.loadMint();
  }

  async createMeltQuote(invoice: string): Promise<MeltQuote> {
    const q = await this.wallet.createMeltQuoteBolt11(invoice);
    return { quote: q.quote, amountSat: q.amount.toNumber(), feeReserveSat: q.fee_reserve.toNumber(), unit: q.unit,
      state: q.state as MeltState, request: q.request };
  }

  async checkMeltQuote(quote: string) {
    const q = await this.wallet.checkMeltQuoteBolt11(quote);
    return { state: q.state as MeltState, preimage: q.payment_preimage ?? null, changeSigs: (q.change ?? []) as unknown[] };
  }

  selectToSend(proofs: StoredProof[], amountSat: number) {
    try {
      const { send, keep } = this.wallet.selectProofsToSend(toProofs(proofs), amountSat, true);
      const total = send.reduce((s, p) => s + p.amount.toNumber(), 0);
      const fees = this.wallet.getFeesForProofs(send).toNumber();
      if (!send.length || total < amountSat + fees) return { send: [], keep: proofs };
      return { send: toStored(send), keep: toStored(keep) };
    } catch {
      return { send: [], keep: proofs };
    }
  }

  async prepareMelt(quote: MeltQuote, inputs: StoredProof[]) {
    const preview = await this.wallet.prepareMelt('bolt11', { quote: quote.quote, amount: quote.amountSat as any }, toProofs(inputs));
    const outputDataJson = JSON.stringify(preview.outputData.map((o) => OutputData.serialize(o)));
    return { preview, outputDataJson };
  }

  async completeMelt(preview: unknown): Promise<MeltOutcome> {
    const r = await this.wallet.completeMelt(preview as any);
    const q = r.quote as any;
    return { state: q.state as MeltState, preimage: q.payment_preimage ?? null, change: toStored(r.change) };
  }

  async changeFromSignatures(outputDataJson: string, sigs: unknown[]): Promise<StoredProof[]> {
    if (!sigs.length) return [];
    const outputs = (JSON.parse(outputDataJson) as any[]).map((s) => OutputData.deserialize(s));
    await this.wallet.ensureOperableKeysets((sigs as Array<{ id: string }>).map((s) => s.id));
    return toStored(this.wallet.createMeltChangeProofs(outputs, sigs as any));
  }

  async checkProofStates(proofs: StoredProof[]) {
    const states = await this.wallet.checkProofsStates(proofs.map((p) => ({ secret: p.secret, id: p.id })));
    return states.map((s) => s.state as 'UNSPENT' | 'PENDING' | 'SPENT');
  }

  async receive(proofs: ProofLike[], opts?: { privkey?: string }): Promise<StoredProof[]> {
    return toStored(await this.wallet.receive(proofs, opts?.privkey ? { privkey: opts.privkey } : undefined));
  }

  async invalidDleq(proofs: ProofLike[]): Promise<number> {
    const r = await this.wallet.verifyMintSignatures(proofs);
    return r.invalid.length;
  }

  feesForInputs(proofs: Array<{ id: string }>): number {
    return this.wallet.getFeesForProofs(proofs).toNumber();
  }

  classifySwapError(e: unknown): 'mint_answered' | 'no_answer' {
    // Unlike a melt, a failed swap moves nothing: only a dead connection, a
    // timeout or a 5xx is worth a retry; anything else will fail the same way.
    if (e instanceof NetworkError) return 'no_answer';
    if (e instanceof HttpResponseError && !(e instanceof MintOperationError) && e.status >= 500) return 'no_answer';
    return 'mint_answered';
  }

  classifyMeltError(e: unknown): MeltErrorKind {
    if (e instanceof MeltChangeError) return 'paid_change_lost';
    // A protocol error or a 4xx is the mint's answer: the request was handled.
    // A 5xx may have died half-way, so it counts as no answer.
    if (e instanceof MintOperationError) return 'mint_answered';
    if (e instanceof HttpResponseError && e.status >= 400 && e.status < 500) return 'mint_answered';
    return 'no_answer';
  }
}

export { MeltQuoteState };
