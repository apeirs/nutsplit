// RSS feed parsing: the parts nutsplit needs from the Podcasting 2.0 namespace.
// Channel and item <podcast:value> (with <podcast:valueTimeSplit>),
// <podcast:guid>, <podcast:txt>, and each item's <guid>.
import { XMLParser } from 'fast-xml-parser';
import type { Recipient, RemoteItem, TimeSplit, ValueBlock } from './split.ts';

export interface FeedItem {
  guid: string;
  title: string;
  link?: string;
  episode?: string;
  value?: ValueBlock;
}

export interface Feed {
  podcastGuid?: string;
  title: string;
  link?: string;
  value?: ValueBlock;
  txt: Array<{ purpose?: string; text: string }>;
  items: FeedItem[];
}

const ARRAYS = new Set([
  'rss.channel.item',
  'rss.channel.podcast:txt',
  'rss.channel.podcast:value',
  'rss.channel.item.podcast:value',
  'rss.channel.podcast:value.podcast:valueRecipient',
  'rss.channel.item.podcast:value.podcast:valueRecipient',
  'rss.channel.podcast:value.podcast:valueTimeSplit',
  'rss.channel.item.podcast:value.podcast:valueTimeSplit',
  'rss.channel.item.podcast:value.podcast:valueTimeSplit.podcast:valueRecipient',
  'rss.channel.podcast:value.podcast:valueTimeSplit.podcast:valueRecipient',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (_name, jpath) => ARRAYS.has(String(jpath)),
});

type Node = Record<string, any>;

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && '#text' in (v as Node)) return String((v as Node)['#text']).trim();
  return String(v).trim();
}

function attr(n: Node | undefined, name: string): string | undefined {
  const v = n?.[`@_${name}`];
  return v === undefined ? undefined : String(v).trim();
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bool(v: string | undefined): boolean {
  return (v ?? '').toLowerCase() === 'true';
}

function recipient(n: Node): Recipient {
  return {
    name: attr(n, 'name') ?? '',
    type: (attr(n, 'type') ?? '').toLowerCase(),
    address: attr(n, 'address') ?? '',
    split: Math.trunc(num(attr(n, 'split')) ?? 0),
    fee: bool(attr(n, 'fee')),
    customKey: attr(n, 'customKey') || undefined,
    customValue: attr(n, 'customValue') || undefined,
  };
}

function timeSplit(n: Node): TimeSplit | undefined {
  const startTime = num(attr(n, 'startTime'));
  const duration = num(attr(n, 'duration'));
  // Same rule as Sovereigncast's feed builder: a split an app would have to
  // guess about (no start, no duration, no target) is left out.
  if (startTime === undefined || !duration || duration <= 0) return undefined;
  const recipients = (n['podcast:valueRecipient'] ?? []).map(recipient).filter((r: Recipient) => r.address);
  const ri = n['podcast:remoteItem'] as Node | undefined;
  const remoteItem: RemoteItem | undefined = ri && attr(ri, 'feedGuid')
    ? { feedGuid: attr(ri, 'feedGuid')!, itemGuid: attr(ri, 'itemGuid'), feedUrl: attr(ri, 'feedUrl'), medium: attr(ri, 'medium') }
    : undefined;
  if (!recipients.length && !remoteItem) return undefined;
  const rp = num(attr(n, 'remotePercentage'));
  return {
    startTime, duration,
    remotePercentage: rp === undefined ? null : rp,
    remoteStartTime: num(attr(n, 'remoteStartTime')),
    recipients, remoteItem,
  };
}

function valueBlock(blocks: Node[] | undefined): ValueBlock | undefined {
  // A feed may carry several value blocks (one per payment type); nutsplit
  // pays Lightning recipients, so it takes the lightning one.
  const n = (blocks ?? []).find((b) => (attr(b, 'type') ?? 'lightning').toLowerCase() === 'lightning');
  if (!n) return undefined;
  return {
    type: attr(n, 'type') ?? 'lightning',
    method: attr(n, 'method') ?? '',
    suggested: attr(n, 'suggested'),
    recipients: (n['podcast:valueRecipient'] ?? []).map(recipient),
    timeSplits: (n['podcast:valueTimeSplit'] ?? []).map(timeSplit).filter(Boolean) as TimeSplit[],
  };
}

export function parseFeed(xml: string): Feed {
  const doc = parser.parse(xml.replace(/^﻿/, '')) as Node;
  const ch = doc?.rss?.channel as Node | undefined;
  if (!ch) throw new Error('not an RSS feed (no rss/channel)');
  const items: FeedItem[] = (ch.item ?? []).map((it: Node) => ({
    guid: text(it.guid),
    title: text(it.title),
    link: text(it.link) || undefined,
    episode: text(it['podcast:episode']) || text(it['itunes:episode']) || undefined,
    value: valueBlock(it['podcast:value']),
  }));
  return {
    podcastGuid: text(ch['podcast:guid']) || undefined,
    title: text(ch.title),
    link: text(ch.link) || undefined,
    value: valueBlock(ch['podcast:value']),
    txt: (ch['podcast:txt'] ?? []).map((t: Node) => ({ purpose: attr(t, 'purpose'), text: text(t) })),
    items,
  };
}

/** The value block that applies to an episode: its own, else the channel's. */
export function valueFor(feed: Feed, episodeGuid?: string): { block?: ValueBlock; item?: FeedItem; source: 'item' | 'channel' | 'none' } {
  const item = episodeGuid ? feed.items.find((i) => i.guid === episodeGuid) : undefined;
  if (item?.value?.recipients.length) return { block: item.value, item, source: 'item' };
  if (feed.value?.recipients.length) return { block: feed.value, item, source: 'channel' };
  return { item, source: 'none' };
}

export interface FeedStats {
  items: number;
  itemsWithValue: number;
  itemsWithMultiRecipientSplit: number;
  timeSplits: number;
  recipients: { node: number; lnaddress: number; other: number };
}

export function feedStats(feed: Feed): FeedStats {
  const s: FeedStats = { items: feed.items.length, itemsWithValue: 0, itemsWithMultiRecipientSplit: 0, timeSplits: 0,
    recipients: { node: 0, lnaddress: 0, other: 0 } };
  const count = (b?: ValueBlock) => {
    for (const r of b?.recipients ?? []) {
      if (r.type === 'node' || r.type === 'keysend') s.recipients.node++;
      else if (r.type === 'lnaddress') s.recipients.lnaddress++;
      else s.recipients.other++;
    }
  };
  count(feed.value);
  for (const it of feed.items) {
    if (!it.value) continue;
    s.itemsWithValue++;
    if (it.value.recipients.length > 1) s.itemsWithMultiRecipientSplit++;
    s.timeSplits += it.value.timeSplits.length;
    count(it.value);
  }
  return s;
}
