// NIP-61 nutzaps: the kind:10019 that tells apps where to send, and the
// checks that turn a kind:9321 into the same payment the NUT-18 intake books.
// No relay and no mint here; nutzap-intake.ts does the I/O.
//
// Context tags are read the way Sovereigncast's nostr_cashu.py reads what the
// Nodesignal cashu-player sends (blip-0010 names: `episode`, `ts`, plus
// `episode_guid`/`guid`), and NIP-73 `i` tags (`podcast:item:guid:…`,
// `podcast:guid:…`). A payment with a listener message, or of 100 sats or
// more, is a boost; anything else is streaming (CASHU_STREAMING.md Route A).
import { getP2PKExpectedWitnessPubkeys, getSecretData, getSecretKind, parseP2PKSecret } from '@cashu/cashu-ts';
import { tagValues, verifyEvent, type EventTemplate, type Filter, type NostrEvent } from './nostr.ts';
import type { Feed } from './feed.ts';
import type { CreditKind, StoredProof } from './ledger.ts';

export const NUTZAP_KIND = 9321;
export const NUTZAP_INFO_KIND = 10019;
export const MAX_PROOFS_PER_EVENT = 64;
export const MAX_PROOF_TAG_LEN = 4096;
export const MAX_MESSAGE_LEN = 300;
export const DEFAULT_BOOST_THRESHOLD_SAT = 100;

export interface NutzapIdentity {
  /** The show's Nostr identity (hex). Nutzaps p-tag it; nutsplit never holds its secret key. */
  nostrPubkey: string;
  /** What nutzaps are locked to: `02` + x-only key, kept by nutsplit. Never the identity key (NIP-61). */
  p2pkPubkey: string;
  /** Accepted mints, without trailing slash, exactly as listed in the kind:10019. */
  mints: string[];
  relays: string[];
}

export type NutzapRejection =
  | 'bad_event' | 'not_a_nutzap' | 'not_for_us' | 'untrusted_mint' | 'unsupported_unit' | 'invalid_proofs'
  | 'wrong_lock' | 'unsupported_lock' | 'other_podcast';

export interface ParsedNutzap {
  eventId: string;
  sender: string;
  createdAt: number;
  mint: string;
  proofs: StoredProof[];
  amountSat: number;
  /** Every proof is P2PK-locked to our key. Unlocked proofs are still taken (they are ours if we swap first). */
  locked: boolean;
  episodeGuid?: string;
  episodeTitle?: string;
  ts?: number;
  message: string;
  kind: CreditKind;
}

export type NutzapCheck = { ok: true; nutzap: ParsedNutzap } | { ok: false; reason: NutzapRejection; detail?: string };

export const normalizeMintUrl = (u: string) => String(u ?? '').trim().replace(/\/+$/, '');

/** x-only, lower case: NUT-11 compares keys this way (the 02/03 prefix is ignored). */
const xOnly = (k: string) => (k.length === 66 ? k.slice(2) : k).toLowerCase();

/** The kind:10019 for the show's identity to sign and publish. */
export function nutzapInfoTemplate(id: NutzapIdentity): EventTemplate {
  return {
    kind: NUTZAP_INFO_KIND,
    content: '',
    tags: [...id.relays.map((r) => ['relay', r]), ...id.mints.map((m) => ['mint', m, 'sat']), ['pubkey', id.p2pkPubkey]],
  };
}

/** The relay filter of NIP-61 "Receiving nutzaps": p-tags us, on our mints only. */
export function nutzapFilter(id: NutzapIdentity, since?: number): Filter {
  return { kinds: [NUTZAP_KIND], '#p': [id.nostrPubkey], '#u': [...id.mints], ...(since !== undefined ? { since } : {}) };
}

const reject = (reason: NutzapRejection, detail?: string): NutzapCheck => ({ ok: false, reason, detail });

function parseProofs(raw: string[]): StoredProof[] | undefined {
  if (!raw.length || raw.length > MAX_PROOFS_PER_EVENT) return undefined;
  const out: StoredProof[] = [];
  for (const r of raw) {
    // Never shorten a field to fit (CASHU_STREAMING.md): over-long is refused.
    if (r.length > MAX_PROOF_TAG_LEN) return undefined;
    let p: any;
    try {
      p = JSON.parse(r);
    } catch {
      return undefined;
    }
    const amount = Number(p?.amount);
    if (!p || typeof p.secret !== 'string' || typeof p.C !== 'string' || typeof p.id !== 'string' || p.id.length > 128
      || !Number.isSafeInteger(amount) || amount <= 0) return undefined;
    out.push({ ...p, amount });
  }
  return out;
}

/** Whether a proof is ours to spend: 'ours' (locked to us), 'open' (no lock in force), or why not. */
function lockOf(secret: string, ourKey: string): 'ours' | 'open' | 'wrong_lock' | 'unsupported_lock' | 'invalid_proofs' {
  let kind: string;
  try {
    kind = getSecretKind(secret);
  } catch {
    return 'open'; // a plain NUT-00 secret
  }
  if (kind !== 'P2PK') return 'unsupported_lock';
  try {
    parseP2PKSecret(secret);
    const nSigs = (getSecretData(secret).tags ?? []).find((t) => t[0] === 'n_sigs')?.[1];
    const signers = getP2PKExpectedWitnessPubkeys(secret).map(xOnly);
    if (!signers.length) return 'open'; // lock expired, no refund keys
    if (!signers.includes(xOnly(ourKey))) return 'wrong_lock';
    if (nSigs !== undefined && Number(nSigs) > 1) return 'unsupported_lock';
    return 'ours';
  } catch {
    return 'invalid_proofs';
  }
}

/** Sovereigncast's _listener_message: drop the "Title · hh:mm:ss — " head the player puts before a message. */
const TIMECODE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const SEP = ' — ';

function looksLikePlayerHead(text: string, title: string): boolean {
  const parts = text.split(' · ').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  if (title && parts[0] === title.trim()) return true;
  return parts.every((p) => TIMECODE.test(p));
}

function stripLeadingTimecode(text: string): string {
  if (!text.startsWith('·')) return text;
  const rest = text.slice(1).trim();
  const i = rest.indexOf(' ');
  const head = i < 0 ? rest : rest.slice(0, i);
  return TIMECODE.test(head) ? (i < 0 ? '' : rest.slice(i + 1).trim()) : text;
}

export function listenerMessage(content: string, episodeTitle = ''): string {
  const text = (content ?? '').trim();
  if (!text) return '';
  const title = episodeTitle.trim();
  if (title && text.startsWith(title)) {
    const rest = stripLeadingTimecode(text.slice(title.length).trim());
    if (!rest) return '';
    if (rest.startsWith('—')) return rest.replace(/^—+/, '').trim();
    return text;
  }
  const i = text.indexOf(SEP);
  if (i >= 0) return looksLikePlayerHead(text.slice(0, i), title) ? text.slice(i + SEP.length).trim() : text;
  return looksLikePlayerHead(text, title) ? '' : text;
}

/** NIP-73 `i` values with a prefix, then the blip-0010 tag. */
function contextValues(e: NostrEvent, iPrefix: string, tag: string): string[] {
  return [
    ...tagValues(e, 'i').filter((v) => v.startsWith(iPrefix)).map((v) => v.slice(iPrefix.length)),
    ...tagValues(e, tag),
  ].map((v) => v.trim()).filter(Boolean);
}

/** The episode a nutzap names: by item guid, else by exact title; unknown means the channel split. */
function attribute(e: NostrEvent, feed: Feed): { episodeGuid?: string; episodeTitle?: string } {
  const titleTag = (tagValues(e, 'episode')[0] ?? '').trim().slice(0, 200);
  for (const g of contextValues(e, 'podcast:item:guid:', 'episode_guid')) {
    const item = feed.items.find((i) => i.guid === g);
    if (item) return { episodeGuid: item.guid, episodeTitle: item.title };
  }
  if (titleTag) {
    const t = titleTag.toLowerCase();
    const item = feed.items.find((i) => i.title.trim().toLowerCase() === t);
    if (item) return { episodeGuid: item.guid, episodeTitle: item.title };
  }
  return { episodeTitle: titleTag || undefined };
}

/**
 * Every check that needs no mint, in the order NIP-61 asks for them: the
 * event is genuine, it is for us, its mint is one we listed, and its proofs
 * are locked to the key we listed. A failed check never contacts the mint.
 */
export function parseNutzap(e: unknown, id: NutzapIdentity, show: { podcastGuid: string; feed: Feed }, boostThresholdSat = DEFAULT_BOOST_THRESHOLD_SAT): NutzapCheck {
  if (!verifyEvent(e)) return reject('bad_event');
  if (e.kind !== NUTZAP_KIND) return reject('not_a_nutzap');
  if (!tagValues(e, 'p').map((p) => p.toLowerCase()).includes(id.nostrPubkey)) return reject('not_for_us');
  const mintTag = tagValues(e, 'u')[0];
  const mint = normalizeMintUrl(mintTag ?? '');
  if (!mint || !id.mints.includes(mint)) return reject('untrusted_mint', mintTag);
  const unit = (tagValues(e, 'unit')[0] ?? 'sat').trim().toLowerCase();
  if (unit !== 'sat') return reject('unsupported_unit', unit);
  const proofs = parseProofs(tagValues(e, 'proof'));
  if (!proofs) return reject('invalid_proofs');
  let locked = true;
  for (const p of proofs) {
    const l = lockOf(p.secret, id.p2pkPubkey);
    if (l === 'open') locked = false;
    else if (l !== 'ours') return reject(l);
  }
  const podcast = contextValues(e, 'podcast:guid:', 'guid');
  if (podcast.length && !podcast.includes(show.podcastGuid)) return reject('other_podcast', podcast[0]);

  const { episodeGuid, episodeTitle } = attribute(e, show.feed);
  const tsRaw = tagValues(e, 'ts')[0];
  const ts = tsRaw !== undefined && /^\d+$/.test(tsRaw.trim()) ? Number(tsRaw) : undefined;
  const amountSat = proofs.reduce((s, p) => s + p.amount, 0);
  // The player builds its head from the title it sent, so strip by that one.
  const message = listenerMessage(e.content, (tagValues(e, 'episode')[0] ?? '').trim() || episodeTitle || '').slice(0, MAX_MESSAGE_LEN);
  return {
    ok: true,
    nutzap: {
      eventId: e.id, sender: e.pubkey, createdAt: e.created_at, mint, proofs, amountSat, locked,
      episodeGuid, episodeTitle, ts, message, kind: message || amountSat >= boostThresholdSat ? 'boost' : 'stream',
    },
  };
}
