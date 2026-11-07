// The ledger: credits in, per-recipient balances, the payout journal and the
// settler's own proofs, in one SQLite file (node:sqlite, no native addon).
//
// Balances are an append-only list of entries in millisats. What a recipient
// is owed is the sum of its entries:
//   share       + its part of a credit
//   intake_fee  - the mint's swap fee on receipt (charged to the fee payer)
//   payout      - an amount reserved for a payout, written *before* the mint
//                 is asked to pay (journal before send, Hopp audit M-09)
//   release     + a payout that provably did not happen (failed)
//   payout_fee  - what a payout cost beyond its amount (to the fee payer)
// When no payout is in flight, the sum of all entries equals the wallet's
// unspent proofs, to the millisat. `reconcile()` checks exactly that.
import { DatabaseSync } from 'node:sqlite';
import { recipientKey, type Recipient } from './split.ts';

export type CreditKind = 'boost' | 'stream';
export type PayoutState = 'unknown' | 'sent' | 'failed' | 'skipped';

export interface CreditInput {
  podcastGuid: string;
  episodeGuid?: string;
  episodeTitle?: string;
  kind: CreditKind;
  /** What the listener sent, before any fee. */
  grossMsat: number;
  ts?: number;
  message?: string;
  sender?: string;
  rail: string;
  mintUrl?: string;
  /** Hash of the incoming proofs' secrets: one credit per token, ever. */
  tokenHash?: string;
  valueSource?: string;
}

export interface ShareMsat {
  recipient: Recipient;
  msat: number;
}

export interface StoredProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: unknown;
  [k: string]: unknown;
}

export interface PayoutRow {
  id: number;
  podcast_guid: string;
  recipient_key: string;
  amount_msat: number;
  rail: string;
  state: PayoutState;
  mint_url: string | null;
  invoice: string | null;
  payment_hash: string | null;
  melt_quote: string | null;
  fee_reserve_sat: number | null;
  inputs_json: string | null;
  output_data_json: string | null;
  inputs_sat: number | null;
  fee_msat: number | null;
  preimage: string | null;
  comment: string | null;
  memo_carried: number | null;
  error: string | null;
  covers_entry_max: number | null;
  created_at: string;
  updated_at: string;
}

export interface RecipientBalance {
  key: string;
  name: string;
  type: string;
  address: string;
  custom_key: string | null;
  custom_value: string | null;
  credited_msat: number;
  owed_msat: number;
  paid_msat: number;
  fees_msat: number;
  unknown_msat: number;
  credits: number;
  payouts_sent: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recipients (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, address TEXT NOT NULL,
  custom_key TEXT, custom_value TEXT, first_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY, podcast_guid TEXT NOT NULL, episode_guid TEXT, episode_title TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('boost','stream')),
  gross_msat INTEGER NOT NULL CHECK (gross_msat >= 0), intake_fee_msat INTEGER NOT NULL DEFAULT 0,
  ts INTEGER, message TEXT, sender TEXT, rail TEXT NOT NULL, mint_url TEXT, token_hash TEXT UNIQUE,
  value_source TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY, podcast_guid TEXT NOT NULL, recipient_key TEXT NOT NULL REFERENCES recipients(key),
  amount_msat INTEGER NOT NULL CHECK (amount_msat >= 0), rail TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('unknown','sent','failed','skipped')),
  mint_url TEXT, invoice TEXT, payment_hash TEXT, melt_quote TEXT, fee_reserve_sat INTEGER,
  inputs_json TEXT, output_data_json TEXT, inputs_sat INTEGER, fee_msat INTEGER, preimage TEXT,
  comment TEXT, memo_carried INTEGER, error TEXT, covers_entry_max INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS payouts_state ON payouts(state);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY, podcast_guid TEXT NOT NULL, recipient_key TEXT NOT NULL REFERENCES recipients(key),
  kind TEXT NOT NULL CHECK (kind IN ('share','intake_fee','payout','release','payout_fee')),
  msat INTEGER NOT NULL, credit_id INTEGER REFERENCES credits(id), payout_id INTEGER REFERENCES payouts(id),
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS entries_recipient ON entries(podcast_guid, recipient_key);
CREATE TABLE IF NOT EXISTS proofs (
  secret TEXT PRIMARY KEY, mint_url TEXT NOT NULL, keyset_id TEXT NOT NULL, amount INTEGER NOT NULL,
  json TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('unspent','reserved','spent')),
  payout_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS proofs_state ON proofs(mint_url, state);
CREATE TABLE IF NOT EXISTS counters (keyset_id TEXT PRIMARY KEY, next INTEGER NOT NULL);
`;

const now = () => new Date().toISOString();

export class Ledger {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in one transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  getMeta(k: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
    return row?.v;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  upsertRecipient(r: Recipient): string {
    const key = recipientKey(r);
    this.db.prepare(`INSERT INTO recipients (key, name, type, address, custom_key, custom_value, first_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET name = excluded.name`)
      .run(key, r.name || r.address, r.type || '', r.address.trim(), r.customKey ?? null, r.customValue ?? null, now());
    return key;
  }

  recipient(key: string): (Recipient & { key: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM recipients WHERE key = ?').get(key) as any;
    if (!row) return undefined;
    return { key, name: row.name, type: row.type, address: row.address, split: 0, fee: false,
      customKey: row.custom_key ?? undefined, customValue: row.custom_value ?? undefined };
  }

  hasToken(tokenHash: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM credits WHERE token_hash = ?').get(tokenHash));
  }

  /**
   * Book a credit and its shares. `shares` must add up to what is split (the
   * gross, or the net when recipients bear the intake fee); `intakeFeeMsat`
   * is charged to `feePayer` when given.
   */
  bookCredit(c: CreditInput, shares: ShareMsat[], intakeFeeMsat: number, feePayer?: Recipient): number {
    const splitTotal = shares.reduce((s, x) => s + x.msat, 0);
    const expected = feePayer ? c.grossMsat : c.grossMsat - intakeFeeMsat;
    if (shares.length && splitTotal !== expected) {
      throw new Error(`shares add up to ${splitTotal} msat, expected ${expected}`);
    }
    return this.tx(() => {
      const t = now();
      const res = this.db.prepare(`INSERT INTO credits (podcast_guid, episode_guid, episode_title, kind, gross_msat,
          intake_fee_msat, ts, message, sender, rail, mint_url, token_hash, value_source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(c.podcastGuid, c.episodeGuid ?? null, c.episodeTitle ?? null, c.kind, c.grossMsat, intakeFeeMsat,
          c.ts ?? null, c.message ?? null, c.sender ?? null, c.rail, c.mintUrl ?? null, c.tokenHash ?? null,
          c.valueSource ?? null, t);
      const creditId = Number(res.lastInsertRowid);
      const ins = this.db.prepare(`INSERT INTO entries (podcast_guid, recipient_key, kind, msat, credit_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const s of shares) {
        if (s.msat <= 0) continue;
        ins.run(c.podcastGuid, this.upsertRecipient(s.recipient), 'share', s.msat, creditId, t);
      }
      if (feePayer && intakeFeeMsat > 0) {
        ins.run(c.podcastGuid, this.upsertRecipient(feePayer), 'intake_fee', -intakeFeeMsat, creditId, t);
      }
      return creditId;
    });
  }

  owedMsat(podcastGuid: string, key: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(msat), 0) AS s FROM entries WHERE podcast_guid = ? AND recipient_key = ?')
      .get(podcastGuid, key) as { s: number };
    return row.s;
  }

  maxEntryId(podcastGuid: string, key: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM entries WHERE podcast_guid = ? AND recipient_key = ?')
      .get(podcastGuid, key) as { m: number };
    return row.m;
  }

  recipientKeys(podcastGuid: string): string[] {
    return (this.db.prepare('SELECT recipient_key AS k FROM entries WHERE podcast_guid = ? GROUP BY recipient_key ORDER BY MIN(id)')
      .all(podcastGuid) as Array<{ k: string }>).map((r) => r.k);
  }

  podcasts(): string[] {
    return (this.db.prepare('SELECT DISTINCT podcast_guid AS g FROM entries').all() as Array<{ g: string }>).map((r) => r.g);
  }

  balances(podcastGuid: string): RecipientBalance[] {
    return this.db.prepare(`
      SELECT r.key, r.name, r.type, r.address, r.custom_key, r.custom_value,
        COALESCE(SUM(CASE WHEN e.kind = 'share' THEN e.msat END), 0) AS credited_msat,
        COALESCE(SUM(e.msat), 0) AS owed_msat,
        COALESCE(SUM(CASE WHEN e.kind IN ('intake_fee','payout_fee') THEN -e.msat END), 0) AS fees_msat,
        (SELECT COALESCE(SUM(amount_msat), 0) FROM payouts p WHERE p.podcast_guid = e.podcast_guid
           AND p.recipient_key = r.key AND p.state = 'sent') AS paid_msat,
        (SELECT COALESCE(SUM(amount_msat), 0) FROM payouts p WHERE p.podcast_guid = e.podcast_guid
           AND p.recipient_key = r.key AND p.state = 'unknown') AS unknown_msat,
        (SELECT COUNT(*) FROM payouts p WHERE p.podcast_guid = e.podcast_guid
           AND p.recipient_key = r.key AND p.state = 'sent') AS payouts_sent,
        COUNT(DISTINCT CASE WHEN e.kind = 'share' THEN e.credit_id END) AS credits
      FROM entries e JOIN recipients r ON r.key = e.recipient_key
      WHERE e.podcast_guid = ?
      GROUP BY r.key ORDER BY MIN(e.id)`).all(podcastGuid) as unknown as RecipientBalance[];
  }

  credits(podcastGuid: string, limit = 500): any[] {
    return this.db.prepare('SELECT * FROM credits WHERE podcast_guid = ? ORDER BY id DESC LIMIT ?').all(podcastGuid, limit);
  }

  creditTotals(podcastGuid: string): { count: number; gross_msat: number; intake_fee_msat: number; boosts: number; streams: number } {
    return this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(gross_msat), 0) AS gross_msat,
        COALESCE(SUM(intake_fee_msat), 0) AS intake_fee_msat,
        COALESCE(SUM(kind = 'boost'), 0) AS boosts, COALESCE(SUM(kind = 'stream'), 0) AS streams
      FROM credits WHERE podcast_guid = ?`).get(podcastGuid) as any;
  }

  // ── Payout journal ─────────────────────────────────────────────────────────

  /**
   * Journal a payout before anything is sent: the row starts as `unknown`
   * (a crash from here on leaves a trace, not nothing), its amount leaves the
   * recipient's balance, and its input proofs are reserved.
   */
  journalPayout(p: {
    podcastGuid: string; recipientKey: string; amountMsat: number; rail: string; mintUrl: string;
    invoice: string; paymentHash?: string; meltQuote: string; feeReserveSat: number;
    inputs: StoredProof[]; outputDataJson: string; comment?: string; memoCarried?: boolean;
  }): number {
    return this.tx(() => {
      const owed = this.owedMsat(p.podcastGuid, p.recipientKey);
      if (p.amountMsat > owed) throw new Error(`payout ${p.amountMsat} msat exceeds owed ${owed} msat`);
      const t = now();
      const coversMax = this.maxEntryId(p.podcastGuid, p.recipientKey);
      const inputsSat = p.inputs.reduce((s, x) => s + x.amount, 0);
      const res = this.db.prepare(`INSERT INTO payouts (podcast_guid, recipient_key, amount_msat, rail, state, mint_url,
          invoice, payment_hash, melt_quote, fee_reserve_sat, inputs_json, output_data_json, inputs_sat, comment,
          memo_carried, covers_entry_max, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p.podcastGuid, p.recipientKey, p.amountMsat, p.rail, p.mintUrl, p.invoice, p.paymentHash ?? null,
          p.meltQuote, p.feeReserveSat, JSON.stringify(p.inputs), p.outputDataJson, inputsSat, p.comment ?? null,
          p.memoCarried === undefined ? null : Number(p.memoCarried), coversMax, t, t);
      const id = Number(res.lastInsertRowid);
      this.db.prepare(`INSERT INTO entries (podcast_guid, recipient_key, kind, msat, payout_id, created_at)
        VALUES (?, ?, 'payout', ?, ?, ?)`).run(p.podcastGuid, p.recipientKey, -p.amountMsat, id, t);
      this.reserveProofs(p.inputs.map((x) => x.secret), id);
      return id;
    });
  }

  payout(id: number): PayoutRow | undefined {
    return this.db.prepare('SELECT * FROM payouts WHERE id = ?').get(id) as PayoutRow | undefined;
  }

  payouts(podcastGuid?: string, state?: PayoutState): PayoutRow[] {
    const where: string[] = [];
    const args: Array<string> = [];
    if (podcastGuid) { where.push('podcast_guid = ?'); args.push(podcastGuid); }
    if (state) { where.push('state = ?'); args.push(state); }
    return this.db.prepare(`SELECT * FROM payouts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`)
      .all(...args) as unknown as PayoutRow[];
  }

  /** The mint paid: inputs are spent, change is ours, the cost beyond the amount is a fee. */
  settleSent(id: number, r: { preimage?: string | null; change: StoredProof[]; feePayer: Recipient | null }): void {
    this.tx(() => {
      const p = this.mustPayout(id, 'unknown');
      const changeSat = r.change.reduce((s, x) => s + x.amount, 0);
      const feeMsat = ((p.inputs_sat ?? 0) - changeSat) * 1000 - p.amount_msat;
      if (feeMsat < 0) throw new Error(`payout ${id}: negative fee ${feeMsat} msat`);
      const t = now();
      this.db.prepare(`UPDATE payouts SET state = 'sent', preimage = ?, fee_msat = ?, error = NULL, updated_at = ? WHERE id = ?`)
        .run(r.preimage ?? null, feeMsat, t, id);
      this.db.prepare(`UPDATE proofs SET state = 'spent', updated_at = ? WHERE payout_id = ? AND state = 'reserved'`).run(t, id);
      this.addProofs(p.mint_url!, r.change);
      if (feeMsat > 0) {
        const payerKey = r.feePayer ? this.upsertRecipient(r.feePayer) : p.recipient_key;
        this.db.prepare(`INSERT INTO entries (podcast_guid, recipient_key, kind, msat, payout_id, created_at)
          VALUES (?, ?, 'payout_fee', ?, ?, ?)`).run(p.podcast_guid, payerKey, -feeMsat, id, t);
      }
    });
  }

  /** Provably not paid (quote UNPAID and every input still unspent): the amount goes back to the recipient. */
  settleFailed(id: number, error: string): void {
    this.tx(() => {
      const p = this.mustPayout(id, 'unknown');
      const t = now();
      this.db.prepare(`UPDATE payouts SET state = 'failed', error = ?, fee_msat = 0, updated_at = ? WHERE id = ?`).run(error, t, id);
      this.db.prepare(`UPDATE proofs SET state = 'unspent', payout_id = NULL, updated_at = ? WHERE payout_id = ? AND state = 'reserved'`).run(t, id);
      this.db.prepare(`INSERT INTO entries (podcast_guid, recipient_key, kind, msat, payout_id, created_at)
        VALUES (?, ?, 'release', ?, ?, ?)`).run(p.podcast_guid, p.recipient_key, p.amount_msat, id, t);
    });
  }

  /** Still unknown: note why, change nothing else. It is never paid again. */
  noteUnknown(id: number, error: string): void {
    this.db.prepare(`UPDATE payouts SET error = ?, updated_at = ? WHERE id = ? AND state = 'unknown'`).run(error, now(), id);
  }

  /** A payout that could not be attempted (no invoice, unpayable by mint …): no money moved. */
  recordSkip(podcastGuid: string, recipientKey: string, amountMsat: number, rail: string, reason: string): number | undefined {
    const last = this.db.prepare(`SELECT state, error, amount_msat FROM payouts WHERE podcast_guid = ? AND recipient_key = ?
      ORDER BY id DESC LIMIT 1`).get(podcastGuid, recipientKey) as any;
    if (last && last.state === 'skipped' && last.error === reason) {
      this.db.prepare(`UPDATE payouts SET amount_msat = ?, updated_at = ? WHERE id = (SELECT MAX(id) FROM payouts
        WHERE podcast_guid = ? AND recipient_key = ?)`).run(amountMsat, now(), podcastGuid, recipientKey);
      return undefined;
    }
    const t = now();
    const res = this.db.prepare(`INSERT INTO payouts (podcast_guid, recipient_key, amount_msat, rail, state, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'skipped', ?, ?, ?)`).run(podcastGuid, recipientKey, amountMsat, rail, reason, t, t);
    return Number(res.lastInsertRowid);
  }

  private mustPayout(id: number, state: PayoutState): PayoutRow {
    const p = this.payout(id);
    if (!p) throw new Error(`no payout ${id}`);
    if (p.state !== state) throw new Error(`payout ${id} is ${p.state}, not ${state}`);
    return p;
  }

  // ── Proofs ────────────────────────────────────────────────────────────────

  addProofs(mintUrl: string, proofs: StoredProof[]): void {
    if (!proofs.length) return;
    this.tx(() => {
      const t = now();
      const ins = this.db.prepare(`INSERT INTO proofs (secret, mint_url, keyset_id, amount, json, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'unspent', ?, ?)`);
      for (const p of proofs) {
        if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new Error(`bad proof amount ${p.amount}`);
        ins.run(p.secret, mintUrl, p.id, p.amount, JSON.stringify(p), t, t);
      }
    });
  }

  unspentProofs(mintUrl: string): StoredProof[] {
    return (this.db.prepare(`SELECT json FROM proofs WHERE mint_url = ? AND state = 'unspent' ORDER BY amount DESC`)
      .all(mintUrl) as Array<{ json: string }>).map((r) => JSON.parse(r.json));
  }

  /** Replace proofs that a swap consumed with the ones it returned, atomically. */
  swapProofs(mintUrl: string, spentSecrets: string[], fresh: StoredProof[]): void {
    this.tx(() => {
      const t = now();
      const upd = this.db.prepare(`UPDATE proofs SET state = 'spent', updated_at = ? WHERE secret = ? AND state = 'unspent'`);
      for (const s of spentSecrets) {
        if (Number(upd.run(t, s).changes) !== 1) throw new Error('proof not unspent');
      }
      this.addProofs(mintUrl, fresh);
    });
  }

  private reserveProofs(secrets: string[], payoutId: number): void {
    const t = now();
    const upd = this.db.prepare(`UPDATE proofs SET state = 'reserved', payout_id = ?, updated_at = ? WHERE secret = ? AND state = 'unspent'`);
    for (const s of secrets) {
      if (Number(upd.run(payoutId, t, s).changes) !== 1) throw new Error('proof not available for reservation');
    }
  }

  walletSat(mintUrl?: string, state: 'unspent' | 'reserved' = 'unspent'): number {
    const row = (mintUrl
      ? this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM proofs WHERE mint_url = ? AND state = ?').get(mintUrl, state)
      : this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM proofs WHERE state = ?').get(state)) as { s: number };
    return row.s;
  }

  mintBalances(): Array<{ mint_url: string; sat: number }> {
    return this.db.prepare(`SELECT mint_url, SUM(amount) AS sat FROM proofs WHERE state = 'unspent' GROUP BY mint_url ORDER BY sat DESC`)
      .all() as any;
  }

  /**
   * Books against wallet: with no payout in flight, everything the recipients
   * are owed (all shows) equals the unspent proofs. In-flight payouts hold
   * reserved proofs worth at least their amount.
   */
  reconcile(): { owedMsat: number; walletMsat: number; reservedMsat: number; unknownMsat: number; ok: boolean } {
    const owed = (this.db.prepare('SELECT COALESCE(SUM(msat), 0) AS s FROM entries').get() as { s: number }).s;
    const unknown = (this.db.prepare(`SELECT COALESCE(SUM(amount_msat), 0) AS s FROM payouts WHERE state = 'unknown'`).get() as { s: number }).s;
    const walletMsat = this.walletSat() * 1000;
    const reservedMsat = this.walletSat(undefined, 'reserved') * 1000;
    const ok = unknown === 0 ? owed === walletMsat && reservedMsat === 0 : owed + unknown <= walletMsat + reservedMsat;
    return { owedMsat: owed, walletMsat, reservedMsat, unknownMsat: unknown, ok };
  }

  // ── NUT-13 counters (deterministic secrets survive a restart) ─────────────

  counterNext(keysetId: string): number {
    const row = this.db.prepare('SELECT next FROM counters WHERE keyset_id = ?').get(keysetId) as { next: number } | undefined;
    return row?.next ?? 0;
  }

  counterSet(keysetId: string, next: number): void {
    this.db.prepare(`INSERT INTO counters (keyset_id, next) VALUES (?, ?)
      ON CONFLICT(keyset_id) DO UPDATE SET next = MAX(next, excluded.next)`).run(keysetId, next);
  }
}
