// The public split ledger: JSON for machines, a small HTML page for people.
// A guest can see what was booked to them, what was paid, with which payment
// hash, and what is still owed, without having to trust the host's word.
import { escapeXml } from './creq.ts';
import { feePayerOf, type Show } from './accrue.ts';
import { isKeysend, isLnaddress, recipientKey } from './split.ts';
import type { Ledger } from './ledger.ts';

const sat = (msat: number) => Math.floor(msat / 1000);

export function ledgerJson(ledger: Ledger, show: Show) {
  const guid = show.podcastGuid;
  const payer = feePayerOf(show);
  const payerKey = payer ? recipientKey(payer) : undefined;
  const t = ledger.creditTotals(guid);
  const recipients = ledger.balances(guid).map((b) => ({
    name: b.name,
    type: b.type,
    address: b.address,
    custom_key: b.custom_key,
    custom_value: b.custom_value,
    paid_by: isKeysend(b) ? 'keysend' : isLnaddress(b) ? 'lnaddress' : 'none',
    reachable: isLnaddress(b) && !isKeysend(b),
    fee_payer: b.key === payerKey,
    credited_msat: b.credited_msat,
    owed_msat: b.owed_msat,
    paid_sats: sat(b.paid_msat),
    fees_sats: sat(b.fees_msat),
    unknown_sats: sat(b.unknown_msat),
    payouts_sent: b.payouts_sent,
    credits: b.credits,
  }));
  const names = new Map(ledger.balances(guid).map((b) => [b.key, b.name || b.address]));
  const payouts = ledger.payouts(guid).reverse().map((p) => ({
    id: p.id,
    recipient: names.get(p.recipient_key) ?? p.recipient_key,
    amount_sats: sat(p.amount_msat),
    state: p.state,
    fee_sats: p.fee_msat === null ? null : p.fee_msat / 1000,
    payment_hash: p.payment_hash,
    preimage: p.preimage,
    memo_carried: p.memo_carried === null ? null : Boolean(p.memo_carried),
    comment: p.comment,
    error: p.error,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));
  const credits = ledger.credits(guid, 200).map((c) => ({
    id: c.id, kind: c.kind, episode_guid: c.episode_guid, episode_title: c.episode_title, gross_sats: sat(c.gross_msat),
    intake_fee_sats: sat(c.intake_fee_msat), message: c.message, rail: c.rail, value_source: c.value_source, created_at: c.created_at,
  }));
  return {
    podcast_guid: guid,
    title: show.feed.title,
    fee_policy: show.feePolicy,
    totals: {
      credits: t.count, boosts: t.boosts, streams: t.streams, received_sats: sat(t.gross_msat), intake_fee_sats: sat(t.intake_fee_msat),
      paid_sats: recipients.reduce((s, r) => s + r.paid_sats, 0),
      payout_fee_sats: payouts.filter((p) => p.state === 'sent' || p.state === 'failed').reduce((s, p) => s + (p.fee_sats ?? 0), 0),
      owed_msat: recipients.reduce((s, r) => s + r.owed_msat, 0),
    },
    reconcile: ledger.reconcile(),
    recipients,
    payouts,
    credits,
  };
}

const fmtMsat = (m: number) => (m % 1000 === 0 ? `${m / 1000}` : (m / 1000).toFixed(3));
const h = (s: unknown) => escapeXml(String(s ?? ''));

export function ledgerHtml(data: ReturnType<typeof ledgerJson>): string {
  const rows = data.recipients.map((r) => `<tr>
    <td><b>${h(r.name)}</b><br><code>${h(r.address.length > 30 ? r.address.slice(0, 14) + '…' + r.address.slice(-8) : r.address)}</code>${r.custom_value ? ` <span class="muted">${h(r.custom_key)}=${h(r.custom_value.length > 20 ? '…' + r.custom_value.slice(-16) : r.custom_value)}</span>` : ''}${r.fee_payer ? ' <span class="tag">pays fees</span>' : ''}</td>
    <td class="n">${fmtMsat(r.credited_msat)}</td>
    <td class="n">${r.paid_sats}</td>
    <td class="n">${r.fees_sats}</td>
    <td class="n">${fmtMsat(r.owed_msat)}</td>
    <td>${r.reachable ? 'Lightning address (melt)' : r.paid_by === 'keysend' ? '<span class="warn">keysend: a mint cannot pay it; kept owed, not redistributed</span>' : 'no method'}</td>
  </tr>`).join('');
  const payouts = data.payouts.slice(0, 100).map((p) => `<tr>
    <td>#${p.id}</td><td>${h(p.recipient)}</td><td class="n">${p.amount_sats}</td>
    <td><span class="st st-${h(p.state)}">${h(p.state)}</span></td>
    <td class="n">${p.fee_sats ?? ''}</td>
    <td>${p.payment_hash ? `<code title="${h(p.payment_hash)}">${h(p.payment_hash.slice(0, 16))}…</code>` : ''}${p.preimage ? `<br><span class="muted">preimage ${h(p.preimage.slice(0, 12))}…</span>` : ''}</td>
    <td class="muted">${p.state === 'sent' && p.memo_carried === false ? 'no_memo: provider takes no comment' : h(p.error ?? '')}</td>
  </tr>`).join('');
  const credits = data.credits.slice(0, 50).map((c) => `<tr>
    <td>${h(c.created_at.slice(11, 19))}</td><td>${h(c.kind)}</td><td class="n">${c.gross_sats}</td>
    <td>${h((c.episode_title ?? 'show').slice(0, 60))}${c.value_source === 'channel' ? ' <span class="muted">(channel split)</span>' : ''}</td><td>${h(c.message ?? '')}</td>
  </tr>`).join('');
  const t = data.totals;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Split ledger · ${h(data.title)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--line:#e4e1d8;--card:#fff;--accent:#7a4f00;--ok:#1f6f3f;--warn:#9a3d00;--unk:#6a3fa0}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a19f97;--line:#2e2d2a;--card:#1c1c1a;--accent:#f0b65a;--ok:#6fcf97;--warn:#f2994a;--unk:#bb8fe8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1060px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted)}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.card b{display:block;font-size:20px}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;min-width:640px}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}
.n{text-align:right;font-variant-numeric:tabular-nums}.tag{font-size:11px;border:1px solid var(--accent);color:var(--accent);border-radius:4px;padding:0 4px}
.warn{color:var(--warn)}.st{font-size:12px;font-weight:600}.st-sent{color:var(--ok)}.st-unknown{color:var(--unk)}.st-failed,.st-skipped{color:var(--warn)}
ul.rules{padding-left:18px}ul.rules li{margin:2px 0}
</style></head><body><main>
<h1>${h(data.title)}</h1>
<div class="muted">Split ledger · podcast:guid <code>${h(data.podcast_guid)}</code> · <a href="?format=json">JSON</a></div>
<div class="cards">
<div class="card"><span class="muted">received</span><b>${t.received_sats} sat</b><span class="muted">${t.credits} payments, ${t.boosts} boosts</span></div>
<div class="card"><span class="muted">paid out</span><b>${t.paid_sats} sat</b><span class="muted">to the feed's recipients</span></div>
<div class="card"><span class="muted">fees</span><b>${t.intake_fee_sats + t.payout_fee_sats} sat</b><span class="muted">${t.intake_fee_sats} intake, ${t.payout_fee_sats} payout</span></div>
<div class="card"><span class="muted">still owed</span><b>${fmtMsat(t.owed_msat)} sat</b><span class="muted">books ${data.reconcile.ok ? 'match' : 'do NOT match'} the wallet</span></div>
</div>
<h2>Recipients</h2>
<div class="wrap"><table><thead><tr><th>Recipient</th><th class="n">Credited</th><th class="n">Paid</th><th class="n">Fees borne</th><th class="n">Owed</th><th>How it is paid</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted">Amounts in sats; credited and owed to the millisat. Fee policy: <b>${h(data.fee_policy)}</b>${data.fee_policy === 'show' ? ' (the show\'s own balance carries every fee, so other recipients get their exact share)' : ''}.</p>
<h2>Payouts</h2>
<div class="wrap"><table><thead><tr><th>#</th><th>To</th><th class="n">Sats</th><th>State</th><th class="n">Fee</th><th>Payment hash</th><th>Note</th></tr></thead><tbody>${payouts || '<tr><td colspan="7" class="muted">none yet</td></tr>'}</tbody></table></div>
<h2>Latest payments in</h2>
<div class="wrap"><table><thead><tr><th>Time (UTC)</th><th>Kind</th><th class="n">Sats</th><th>Episode</th><th>Message</th></tr></thead><tbody>${credits || '<tr><td colspan="5" class="muted">none yet</td></tr>'}</tbody></table></div>
<h2>Rules</h2>
<ul class="rules muted">
<li>Each payment is split by the episode's <code>podcast:value</code> block (the channel's if the episode has none), with value-time-splits by playback position.</li>
<li>Boosts split in whole sats by largest remainder (21 sats at 80/20 are 17 + 4); streaming splits to the millisat and the rest carries.</li>
<li>A recipient is paid in one Lightning payment once its balance passes the threshold, so fees are paid once per batch, not once per listener.</li>
<li>A share that cannot be paid is shown and kept, never given to the others.</li>
<li>Every payout is written down before the mint is asked; an unknown outcome is never paid again, only settled from the mint's record.</li>
</ul>
</main></body></html>`;
}
