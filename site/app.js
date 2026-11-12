// The split playground on the demo page. The math is src/split.ts (built into split.js);
// pickBlock() is src/feed.ts valueFor() and the boost/stream units follow src/accrue.ts accrue().
import { resolveValue, isKeysend, isLnaddress } from './split.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const short = (a) => (a.length > 40 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a);

let feed;
let kind = 'boost';

function pickBlock(item) {
  if (item?.value?.recipients?.length) return { block: item.value, source: 'item' };
  if (feed.value?.recipients?.length) return { block: feed.value, source: 'channel' };
  return { source: 'none' };
}

function sharesFor(block, sats) {
  // A boost is split in whole sats; streaming is split to the millisat (accrue.ts).
  if (kind === 'boost') return resolveValue(block, null, sats).map((s) => ({ r: s.recipient, msat: s.amount * 1000 }));
  return resolveValue(block, null, sats * 1000).map((s) => ({ r: s.recipient, msat: s.amount }));
}

function howPaid(r) {
  if (isKeysend(r)) return '<span class="warn">keysend: a mint can\'t pay it, so it stays owed (never given to others)</span>';
  if (isLnaddress(r)) return '<span class="ok">melt to the Lightning address</span>';
  return '<span class="warn">no payable address</span>';
}

function render() {
  const item = feed.items.find((i) => i.guid === $('ep').value);
  const { block, source } = pickBlock(item);
  const sats = Math.max(1, Math.trunc(Number($('amt').value) || 0));
  const out = $('out');
  if (!block) { out.innerHTML = '<tr><td colspan="5">This episode has no value block.</td></tr>'; return; }
  const shares = sharesFor(block, sats);
  const total = block.recipients.filter((r) => !r.fee).reduce((a, r) => a + Math.max(0, Math.trunc(Number(r.split)) || 0), 0);
  out.innerHTML = shares.map(({ r, msat }) => {
    const pct = r.fee ? `${r.split}% fee` : total ? `${Math.round((Number(r.split) / total) * 1000) / 10}%` : '';
    const gets = kind === 'boost' ? `${fmt(msat / 1000)} sat` : `${(msat / 1000).toFixed(3)} sat`;
    const w = Math.max(1, Math.round((msat / (sats * 1000)) * 100));
    return `<tr><td><b>${esc(r.name || '(no name)')}</b><div class="addr mono">${esc(short(r.address ?? ''))}</div></td>`
      + `<td class="n">${esc(pct)}</td><td class="n"><b>${gets}</b></td><td class="hide-s"><div class="bar" style="width:${w}%"></div></td><td>${howPaid(r)}</td></tr>`;
  }).join('');
  $('rule').textContent = (source === 'channel' ? 'This episode has no split of its own, so the channel\'s applies. ' : '')
    + (kind === 'boost'
      ? 'Boosts split in whole sats, largest remainder, ties in feed order (Hopp ADR 0005: 21 sats at 80/20 are 17 + 4).'
      : 'Streaming splits to the millisat; whole sats are paid and the remainder carries in each balance (Hopp ADR 0014).');

  // A whole audience: each listener paying the split itself vs nutsplit's batched payouts.
  const n = Math.max(1, Math.trunc(Number($('n').value) || 1));
  const perListener = shares.filter((s) => s.msat >= 1000);
  const payable = shares.filter((s) => isLnaddress(s.r) && !isKeysend(s.r));
  const owed = shares.filter((s) => isKeysend(s.r));
  $('direct').textContent = fmt(n * perListener.length);
  $('direct-sub').textContent = `${fmt(n)} listeners × ${perListener.length} recipients with a share of 1 sat or more`;
  $('batched').textContent = fmt(payable.length);
  const owedSat = owed.reduce((a, s) => a + s.msat, 0) * n / 1000;
  $('batched-sub').textContent = payable.map((s) => `${s.r.name}: ${fmt(Math.floor((s.msat * n) / 1000))} sat`).join(' · ')
    + (owed.length ? ` · kept owed (keysend): ${fmt(Math.floor(owedSat))} sat` : '');
}

async function main() {
  feed = await (await fetch('feed.json')).json();
  const sel = $('ep');
  for (const it of feed.items) {
    const { block, source } = pickBlock(it);
    if (!block) continue;
    const o = document.createElement('option');
    o.value = it.guid;
    o.textContent = `${it.title}  (${block.recipients.length} recipient${block.recipients.length === 1 ? '' : 's'}${source === 'channel' ? ', channel split' : ''})`;
    sel.append(o);
  }
  sel.value = '7d3a1f3d-c709-4eaa-8f8b-2260330ee403'; // E301: Nodesignal LN 80 / zettizettler 20
  if (!sel.value) sel.selectedIndex = 0;
  sel.addEventListener('change', render);
  $('amt').addEventListener('input', render);
  $('n').addEventListener('input', render);
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      kind = b.dataset.kind;
      for (const x of document.querySelectorAll('.seg button')) x.setAttribute('aria-pressed', String(x === b));
      if (kind === 'stream' && Number($('amt').value) === 21) $('amt').value = 5;
      if (kind === 'boost' && Number($('amt').value) === 5) $('amt').value = 21;
      render();
    });
  }
  render();
  // Numbers of the real run, from its own JSON.
  try {
    const l = await (await fetch('demo/ledger.json')).json();
    const t = l.totals;
    const sent = l.payouts.filter((p) => p.state === 'sent').length;
    const card = (label, big, sub) => `<div class="card"><span>${label}</span><b>${big}</b><span>${sub}</span></div>`;
    $('cards').innerHTML = card('received', `${fmt(t.received_sats)} sat`, `${t.credits} payments, ${t.boosts} boosts`)
      + card('paid out', `${fmt(t.paid_sats)} sat`, `${sent} Lightning payments`)
      + card('fees', `${fmt(t.intake_fee_sats + t.payout_fee_sats)} sat`, `${t.intake_fee_sats} intake, ${t.payout_fee_sats} payout`)
      + card('still owed', `${fmt(Math.floor(t.owed_msat / 1000))} sat`, l.reconcile?.ok ? 'books match the wallet' : 'books do NOT match');
    const d = l.payouts[0]?.created_at?.slice(0, 10);
    if (d) $('run-date').textContent = d;
  } catch { /* the static numbers above stay */ }
}
main();
