import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseFeed, valueFor, feedStats } from '../src/feed.ts';
import { resolveValue, splitRecipients, isKeysend } from '../src/split.ts';

// Snapshot of https://serve.podhome.fm/rss/e8df0b13-47de-544a-99b7-ec7cbd960a16, 2026-11-07.
const feed = parseFeed(gunzipSync(readFileSync(new URL('./fixtures/nodesignal-feed.xml.gz', import.meta.url))).toString('utf8'));
const E301 = '7d3a1f3d-c709-4eaa-8f8b-2260330ee403';
const E243 = 'Nodesignal-Talk - E243 - Saturdays for Satoshi';

test('the Nodesignal feed: guid, txt records, 331 items', () => {
  assert.equal(feed.podcastGuid, 'e8df0b13-47de-544a-99b7-ec7cbd960a16');
  assert.equal(feed.items.length, 331);
  assert.deepEqual(feed.txt.map((t) => t.purpose), ['sovereigncast', 'nostr']);
  assert.equal(feed.value?.recipients[0].address, 'nodesignal@getalby.com');
});

test('recipient counts match what RESEARCH.md measured (339 node, 63 item lnaddress + 1 channel)', () => {
  const s = feedStats(feed);
  assert.equal(s.itemsWithMultiRecipientSplit, 163);
  assert.deepEqual(s.recipients, { node: 339, lnaddress: 64, other: 0 });
});

test('E301 resolves to its own 80/20 lnaddress split', () => {
  const { block, item, source } = valueFor(feed, E301);
  assert.equal(source, 'item');
  assert.match(item!.title, /E301/);
  assert.deepEqual(block!.recipients.map((r) => [r.address, r.type, r.split]),
    [['nodesignal@getalby.com', 'lnaddress', 80], ['zettizettler@getalby.com', 'lnaddress', 20]]);
  assert.deepEqual(splitRecipients(block!.recipients, 21).map((s) => s.amount), [17, 4]);
});

test('an unknown episode, or one without its own block, falls back to the channel block', () => {
  const { block, source } = valueFor(feed, 'no-such-guid');
  assert.equal(source, 'channel');
  assert.deepEqual(block!.recipients.map((r) => r.split), [100]);
  const without = feed.items.find((i) => !i.value)!;
  assert.equal(valueFor(feed, without.guid).source, 'channel');
});

test('E243: two sub-wallets on one node, and remote-item music splits that pay the base block', () => {
  const it = feed.items.find((i) => i.title === E243)!;
  const v = it.value!;
  assert.deepEqual(v.recipients.map((r) => [r.customValue, r.split]), [['2', 80], ['3', 20]]);
  assert.ok(v.recipients.every(isKeysend));
  assert.deepEqual(v.timeSplits.map((t) => [t.startTime, t.duration, t.remotePercentage, t.remoteItem?.medium]),
    [[0, 91, 100, 'music'], [4864, 91, 100, 'music']]);
  // ts=30 is inside the song; with no resolver for the Wavlake feed the base
  // block is paid, as in Sovereigncast's _resolve_v4v_value.
  assert.deepEqual(resolveValue(v, 30, 100).map((s) => s.amount), [80, 20]);
});

test('inline time splits, missing attributes and multiple value blocks', () => {
  const xml = `<?xml version="1.0"?><rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
    <title>T</title><podcast:guid>g-1</podcast:guid>
    <podcast:txt purpose="cashu">creqAxyz</podcast:txt>
    <item><title>One</title><guid isPermaLink="false">ep-1</guid>
      <podcast:value type="bitcoin" method="x"><podcast:valueRecipient address="bc1q" split="100"/></podcast:value>
      <podcast:value type="lightning" method="keysend">
        <podcast:valueRecipient name="Host" address="host@x.test" split="90"/>
        <podcast:valueRecipient name="App" type="lnaddress" address="app@x.test" split="10" fee="true"/>
        <podcast:valueTimeSplit startTime="300" duration="60">
          <podcast:valueRecipient name="Guest" type="lnaddress" address="guest@x.test" split="100"/>
        </podcast:valueTimeSplit>
        <podcast:valueTimeSplit startTime="10"><podcast:valueRecipient name="X" address="x@x.test" split="1"/></podcast:valueTimeSplit>
      </podcast:value>
    </item></channel></rss>`;
  const f = parseFeed(xml);
  assert.equal(f.podcastGuid, 'g-1');
  assert.deepEqual(f.txt, [{ purpose: 'cashu', text: 'creqAxyz' }]);
  const v = f.items[0].value!;
  assert.equal(v.type, 'lightning');
  assert.deepEqual(v.recipients.map((r) => [r.name, r.fee]), [['Host', false], ['App', true]]);
  assert.equal(v.timeSplits.length, 1, 'a split without a duration is left out');
  assert.equal(v.timeSplits[0].remotePercentage, null);
  assert.deepEqual(resolveValue(v, 320, 1000).map((s) => [s.recipient.name, s.amount]), [['Guest', 1000]]);
  assert.deepEqual(resolveValue(v, 100, 1000).map((s) => [s.recipient.name, s.amount]), [['Host', 900], ['App', 100]]);
});

test('not an RSS document is an error, not an empty feed', () => {
  assert.throws(() => parseFeed('<html><body>hi</body></html>'), /not an RSS feed/);
});
