// The little Nostr nutsplit needs: NIP-01 events (hash, verify, sign), NIP-19
// npub, and one subscription to a relay that reconnects on its own. Global
// WebSocket (Node 22+) and @noble/curves, no Nostr library.
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bech32 } from '@scure/base';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type EventTemplate = Pick<NostrEvent, 'kind' | 'tags' | 'content'> & { created_at?: number };

export interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

const HEX64 = /^[0-9a-f]{64}$/;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** NIP-01: sha256 of [0, pubkey, created_at, kind, tags, content]. */
export function eventHash(e: Omit<NostrEvent, 'id' | 'sig'>): string {
  return createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
}

/** Well-formed, the id is the hash of the content, and the author signed it. */
export function verifyEvent(e: unknown): e is NostrEvent {
  const x = e as NostrEvent;
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || typeof x.pubkey !== 'string' || typeof x.sig !== 'string'
    || !Number.isSafeInteger(x.created_at) || !Number.isSafeInteger(x.kind) || typeof x.content !== 'string'
    || !Array.isArray(x.tags) || !x.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === 'string'))) return false;
  if (!HEX64.test(x.id) || !HEX64.test(x.pubkey) || !/^[0-9a-f]{128}$/.test(x.sig)) return false;
  if (eventHash(x) !== x.id) return false;
  try {
    return schnorr.verify(Buffer.from(x.sig, 'hex'), Buffer.from(x.id, 'hex'), Buffer.from(x.pubkey, 'hex'));
  } catch {
    return false;
  }
}

export function publicKeyOf(secretKeyHex: string): string {
  return hex(schnorr.getPublicKey(Buffer.from(secretKeyHex, 'hex')));
}

export function newSecretKey(): string {
  return hex(schnorr.utils.randomSecretKey());
}

export function signEvent(t: EventTemplate, secretKeyHex: string): NostrEvent {
  const e = { pubkey: publicKeyOf(secretKeyHex), created_at: t.created_at ?? Math.floor(Date.now() / 1000), kind: t.kind, tags: t.tags, content: t.content };
  const id = eventHash(e);
  return { ...e, id, sig: hex(schnorr.sign(Buffer.from(id, 'hex'), Buffer.from(secretKeyHex, 'hex'))) };
}

/** A hex pubkey from `npub1…` or 64 hex characters. */
export function toHexPubkey(s: string): string {
  const v = s.trim().toLowerCase();
  if (HEX64.test(v)) return v;
  if (v.startsWith('npub1')) {
    const d = bech32.decodeToBytes(v);
    if (d.prefix === 'npub' && d.bytes.length === 32) return hex(d.bytes);
  }
  throw new Error(`not a Nostr public key: ${s.slice(0, 20)}`);
}

export function npub(hexPubkey: string): string {
  return bech32.encodeFromBytes('npub', Buffer.from(hexPubkey, 'hex'));
}

/** Values of every tag named `name` (the tag's first value). */
export function tagValues(e: Pick<NostrEvent, 'tags'>, name: string): string[] {
  return e.tags.filter((t) => t[0] === name && t.length >= 2).map((t) => t[1]);
}

export interface RelaySubscriptionOptions {
  /** Filters for each (re)subscription, so a reconnect can resume from a cursor. */
  filters: () => Filter[];
  onEvent: (e: NostrEvent, relay: string) => void;
  onEose?: (relay: string) => void;
  log?: (line: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * One REQ on one relay, kept open: on a close, an error or a CLOSED it
 * reconnects with exponential backoff (1 s to 60 s) and asks again with fresh
 * filters. Events go out unverified; the receiver verifies.
 */
export class RelaySubscription {
  readonly url: string;
  private readonly o: RelaySubscriptionOptions;
  private ws?: WebSocket;
  private timer?: NodeJS.Timeout;
  private backoff: number;
  private stopped = false;
  private readonly subId = 'nutsplit-' + randomBytes(4).toString('hex');

  constructor(url: string, o: RelaySubscriptionOptions) {
    if (!/^wss?:\/\//.test(url)) throw new Error(`relay URL must be ws:// or wss://: ${url}`);
    this.url = url;
    this.o = o;
    this.backoff = o.minBackoffMs ?? 1000;
  }

  start(): this {
    this.stopped = false;
    this.connect();
    return this;
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(['CLOSE', this.subId]));
      this.ws?.close();
    } catch { /* already gone */ }
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.o.log?.(`relay ${this.url}: ${(e as Error).message}`);
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = this.o.minBackoffMs ?? 1000;
      ws.send(JSON.stringify(['REQ', this.subId, ...this.o.filters()]));
    };
    ws.onmessage = (m) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT' && msg[1] === this.subId && msg[2] && typeof msg[2] === 'object') this.o.onEvent(msg[2] as NostrEvent, this.url);
      else if (msg[0] === 'EOSE' && msg[1] === this.subId) this.o.onEose?.(this.url);
      else if (msg[0] === 'CLOSED' && msg[1] === this.subId) {
        this.o.log?.(`relay ${this.url} closed the subscription: ${String(msg[2] ?? '')}`);
        ws.close();
      } else if (msg[0] === 'NOTICE') this.o.log?.(`relay ${this.url}: ${String(msg[1] ?? '').slice(0, 200)}`);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws === ws) this.retry();
    };
  }

  private retry(): void {
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? 60_000);
    this.o.log?.(`relay ${this.url}: not connected, retrying in ${Math.round(wait / 1000)} s`);
    this.timer = setTimeout(() => this.connect(), wait);
    this.timer.unref();
  }
}
