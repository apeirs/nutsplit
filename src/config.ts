// Loading a show and a settler from command-line options.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseFeed, type Feed } from './feed.ts';
import { Ledger } from './ledger.ts';
import { CashuMint } from './mint.ts';
import type { LnurlDeps } from './lnurl.ts';
import type { FeePolicy, Show } from './accrue.ts';

export const FEED_MAX_BYTES = 32 * 1024 * 1024; // Hopp audit M-02

/** A feed from a file (plain or .gz) or an https URL, size-limited. */
export async function loadFeed(src: string): Promise<Feed> {
  if (/^https?:\/\//.test(src)) {
    if (!src.startsWith('https://')) throw new Error('feed URL must be https');
    const res = await fetch(src, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`feed: HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > FEED_MAX_BYTES) throw new Error('feed too large');
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > FEED_MAX_BYTES) { await reader.cancel(); throw new Error('feed too large'); }
      chunks.push(value);
    }
    return parseFeed(Buffer.concat(chunks).toString('utf8'));
  }
  const raw = readFileSync(src);
  const { gunzipSync } = await import('node:zlib');
  return parseFeed((src.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
}

/** The wallet seed (NUT-13), created once in the data directory, mode 0600. */
export function loadSeed(dataDir: string): Uint8Array {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'seed.secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(64).toString('hex') + '\n', { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

export function isTestMint(url: string): boolean {
  const host = new URL(url).hostname;
  return /(^|\.)testnut\./.test(host) || host === '127.0.0.1' || host === 'localhost';
}

export interface Settler {
  ledger: Ledger;
  show: Show;
  mints: CashuMint[];
  lnurl: LnurlDeps;
}

/**
 * `lnurlMap` maps a feed address to a stand-in LNURL-pay URL. With a test
 * mint, an address without a stand-in is refused unless `allowRealLnurl`:
 * asking a real provider's callback creates a real invoice in a stranger's
 * account, which a test run has no business doing.
 */
export async function openSettler(o: {
  feed: string; mints: string[]; dataDir: string; feePolicy?: FeePolicy; podcastGuid?: string;
  lnurlMap?: Record<string, string>; allowRealLnurl?: boolean;
}): Promise<Settler> {
  const feed = await loadFeed(o.feed);
  const podcastGuid = o.podcastGuid ?? feed.podcastGuid;
  if (!podcastGuid) throw new Error('the feed has no <podcast:guid>; pass --podcast-guid');
  const ledger = new Ledger(join(o.dataDir, 'nutsplit.sqlite'));
  const seed = loadSeed(o.dataDir);
  const mints = o.mints.map((m) => new CashuMint(m, { seed, ledger }));
  for (const m of mints) await m.load();
  const testOnly = o.mints.every(isTestMint) && !o.allowRealLnurl;
  const map = Object.fromEntries(Object.entries(o.lnurlMap ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const lnurl: LnurlDeps = {
    urlFor: (user, domain, address) => {
      const mapped = map[address.toLowerCase()];
      if (mapped) return mapped;
      if (testOnly) throw new Error(`test mint: no stand-in for ${address}, not contacting a real provider (--allow-real-lnurl to override)`);
      return `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`;
    },
  };
  if (Object.keys(map).length) {
    // Stand-ins usually live on localhost over http.
    const prefixes = Object.values(map).map((u) => new URL(u).origin + '/');
    const { isPublicHttpsUrl } = await import('./lnurl.ts');
    lnurl.isSafeUrl = async (url) => prefixes.some((p) => url.startsWith(p)) || isPublicHttpsUrl(url);
  }
  return { ledger, show: { podcastGuid, feed, feePolicy: o.feePolicy ?? 'show' }, mints, lnurl };
}
