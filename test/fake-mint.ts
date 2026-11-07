// An in-memory mint for settlement tests. Fees like testnut's: 100 ppk per
// input, Lightning reserve max(2 sat, 1 %), the payment itself costs 1 sat.
import { randomBytes } from 'node:crypto';
import type { MintClient, MeltQuote, MeltOutcome, MeltErrorKind, MeltState } from '../src/mint.ts';
import type { StoredProof } from '../src/ledger.ts';

export class MintAnswered extends Error {}
export class NoAnswer extends Error {}

export type MeltMode = 'pay' | 'refuse' | 'timeout_paid' | 'timeout_unpaid' | 'pending';

interface Quote { q: MeltQuote; invoice: string; state: MeltState; change: StoredProof[] }

export class FakeMint implements MintClient {
  readonly mintUrl: string;
  mode: MeltMode = 'pay';
  lnFeeSat = 1;
  spent = new Set<string>();
  pending = new Set<string>();
  quotes = new Map<string, Quote>();
  /** Every invoice the mint paid, with its amount: what the "recipients" got. */
  paid: Array<{ invoice: string; amountSat: number }> = [];
  calls: string[] = [];

  constructor(mintUrl = 'https://fake.mint') {
    this.mintUrl = mintUrl;
  }

  static proofs(amounts: number[]): StoredProof[] {
    return amounts.map((amount) => ({ id: '00fa', amount, secret: randomBytes(16).toString('hex'), C: '02' + 'c'.repeat(64) }));
  }

  /** Split a sum into powers of two, as a mint would. */
  static denominate(sat: number): StoredProof[] {
    const out: number[] = [];
    for (let b = 1; sat > 0; b *= 2) { if (sat & b) { out.push(b); sat -= b; } }
    return FakeMint.proofs(out);
  }

  async load() {}

  feesForInputs(proofs: Array<{ id: string }>) {
    return Math.ceil((proofs.length * 100) / 1000);
  }

  async createMeltQuote(invoice: string): Promise<MeltQuote> {
    this.calls.push('quote');
    const { decodeBolt11 } = await import('../src/bolt11.ts');
    const amountSat = decodeBolt11(invoice).amountMsat! / 1000;
    const q: MeltQuote = { quote: randomBytes(8).toString('hex'), amountSat, feeReserveSat: Math.max(2, Math.ceil(amountSat / 100)), unit: 'sat', state: 'UNPAID' };
    this.quotes.set(q.quote, { q, invoice, state: 'UNPAID', change: [] });
    return q;
  }

  async checkMeltQuote(quote: string) {
    this.calls.push('check');
    const x = this.quotes.get(quote);
    if (!x) throw new MintAnswered('unknown quote');
    return { state: x.state, preimage: x.state === 'PAID' ? 'ab'.repeat(32) : null, changeSigs: x.change as unknown[] };
  }

  selectToSend(proofs: StoredProof[], amountSat: number) {
    const sorted = [...proofs].sort((a, b) => b.amount - a.amount);
    const send: StoredProof[] = [];
    let total = 0;
    for (const p of sorted) {
      if (total >= amountSat + this.feesForInputs(send)) break;
      send.push(p);
      total += p.amount;
    }
    if (total < amountSat + this.feesForInputs(send)) return { send: [], keep: proofs };
    return { send, keep: proofs.filter((p) => !send.includes(p)) };
  }

  async prepareMelt(quote: MeltQuote, inputs: StoredProof[]) {
    return { preview: { quote: quote.quote, inputs }, outputDataJson: '[]' };
  }

  async completeMelt(preview: unknown): Promise<MeltOutcome> {
    this.calls.push('melt');
    const { quote, inputs } = preview as { quote: string; inputs: StoredProof[] };
    const x = this.quotes.get(quote)!;
    if (inputs.some((p) => this.spent.has(p.secret))) throw new MintAnswered('Token already spent');
    const total = inputs.reduce((s, p) => s + p.amount, 0);
    if (total < x.q.amountSat + x.q.feeReserveSat + this.feesForInputs(inputs)) throw new MintAnswered('inputs below amount + reserve');
    if (this.mode === 'refuse') throw new MintAnswered('Lightning payment failed');
    if (this.mode === 'timeout_unpaid') throw new NoAnswer('fetch failed: timeout');
    if (this.mode === 'pending') {
      for (const p of inputs) this.pending.add(p.secret);
      x.state = 'PENDING';
      return { state: 'PENDING', preimage: null, change: [] };
    }
    for (const p of inputs) this.spent.add(p.secret);
    x.state = 'PAID';
    x.change = FakeMint.denominate(total - x.q.amountSat - this.lnFeeSat - this.feesForInputs(inputs));
    this.paid.push({ invoice: x.invoice, amountSat: x.q.amountSat });
    if (this.mode === 'timeout_paid') throw new NoAnswer('socket hang up');
    return { state: 'PAID', preimage: 'ab'.repeat(32), change: x.change };
  }

  /** Later: a PENDING payment completes. */
  completePending(quote: string) {
    const x = this.quotes.get(quote)!;
    x.state = 'PAID';
    for (const s of this.pending) this.spent.add(s);
    this.pending.clear();
    this.paid.push({ invoice: x.invoice, amountSat: x.q.amountSat });
  }

  async changeFromSignatures(_outputDataJson: string, sigs: unknown[]) {
    return sigs as StoredProof[];
  }

  async checkProofStates(proofs: StoredProof[]) {
    this.calls.push('states');
    return proofs.map((p) => (this.spent.has(p.secret) ? 'SPENT' : this.pending.has(p.secret) ? 'PENDING' : 'UNSPENT') as 'SPENT' | 'PENDING' | 'UNSPENT');
  }

  async receive(proofs: any[]): Promise<StoredProof[]> {
    this.calls.push('swap');
    if (proofs.some((p) => this.spent.has(p.secret))) throw new MintAnswered('Token already spent');
    for (const p of proofs) this.spent.add(p.secret);
    const total = proofs.reduce((s, p) => s + Number(p.amount), 0);
    return FakeMint.denominate(total - this.feesForInputs(proofs));
  }

  async invalidDleq() {
    return 0;
  }

  classifyMeltError(e: unknown): MeltErrorKind {
    return e instanceof MintAnswered ? 'mint_answered' : 'no_answer';
  }
}
