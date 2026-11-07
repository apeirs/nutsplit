#!/usr/bin/env node
// nutsplit command line.
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, MintQuoteState, deserializeProofs, serializeProofs, type Proof } from '@cashu/cashu-ts';
import { openSettler, isTestMint } from '../src/config.ts';
import { createNutsplitServer } from '../src/server.ts';
import { settle, type SettleReport } from '../src/settle.ts';
import { feedLine, feedPaymentRequest } from '../src/creq.ts';
import { ledgerJson } from '../src/report.ts';
import { payShow } from '../src/listener.ts';

const HELP = `nutsplit: settle Cashu a podcast receives to its podcast:value split

  nutsplit serve     --feed <https URL|file> --mint <url> [--mint <url>…] [--data ./data]
                     [--port 8787] [--public-url URL] [--threshold 210] [--settle-every 300]
                     [--fee-policy show|recipient] [--lnurl-map addr=url …] [--rate-limit 10]
  nutsplit settle    --feed … --mint … [--data ./data] [--threshold 210] [--force] [--lnurl-map …]
  nutsplit ledger    --feed … --mint … [--data ./data]
  nutsplit feed-line --public-url URL --podcast-guid GUID [--title T]
  nutsplit pay       --creq creqA… --mint <test mint> --sats N [--episode GUID] [--stream] [--ts S]
                     [--msg TEXT] [--fund N] [--data ./data]   (a test listener)
`;

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    feed: { type: 'string' }, mint: { type: 'string', multiple: true }, data: { type: 'string', default: './data' },
    port: { type: 'string', default: '8787' }, 'public-url': { type: 'string' }, threshold: { type: 'string', default: '210' },
    'settle-every': { type: 'string', default: '0' }, 'fee-policy': { type: 'string', default: 'show' },
    'lnurl-map': { type: 'string', multiple: true }, 'allow-real-lnurl': { type: 'boolean', default: false },
    'rate-limit': { type: 'string', default: '10' }, force: { type: 'boolean', default: false },
    'podcast-guid': { type: 'string' }, title: { type: 'string' }, creq: { type: 'string' }, sats: { type: 'string' },
    episode: { type: 'string' }, stream: { type: 'boolean', default: false }, ts: { type: 'string' }, msg: { type: 'string' },
    fund: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false },
  },
});

const die = (m: string): never => { console.error(m); process.exit(2); };
const cmd = positionals[0];
if (!cmd || v.help) { console.log(HELP); process.exit(cmd ? 0 : 2); }

function lnurlMap(): Record<string, string> {
  return Object.fromEntries((v['lnurl-map'] ?? []).map((kv) => {
    const i = kv.indexOf('=');
    if (i < 1) die(`--lnurl-map expects addr=url, got ${kv}`);
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
}

async function settler() {
  if (!v.feed) die('--feed is required');
  if (!v.mint?.length) die('--mint is required');
  const fp = v['fee-policy'];
  if (fp !== 'show' && fp !== 'recipient') die('--fee-policy is show or recipient');
  return openSettler({ feed: v.feed!, mints: v.mint!, dataDir: v.data!, feePolicy: fp as 'show' | 'recipient',
    podcastGuid: v['podcast-guid'], lnurlMap: lnurlMap(), allowRealLnurl: v['allow-real-lnurl'] });
}

function printReport(r: SettleReport) {
  for (const x of r.resolved) console.log(`resolved payout #${x.payoutId}: ${x.state} (${x.note})`);
  for (const p of r.payouts) console.log(`${p.outcome.padEnd(8)} ${String(p.amountSat).padStart(6)} sat  ${p.name}${p.feeSat !== undefined ? `  fee ${p.feeSat}` : ''}${p.reason ? `  (${p.reason})` : ''}`);
}

if (cmd === 'serve') {
  const s = await settler();
  const threshold = Number(v.threshold);
  const server = createNutsplitServer({ ledger: s.ledger, shows: [s.show], mints: s.mints, publicUrl: v['public-url'],
    rateLimitPerMin: Number(v['rate-limit']), log: (l) => console.log(new Date().toISOString(), l) });
  server.listen(Number(v.port), '127.0.0.1', () => console.log(`nutsplit for ${s.show.feed.title} on http://127.0.0.1:${v.port} (ledger: /ledger/${s.show.podcastGuid})`));
  const every = Number(v['settle-every']);
  if (every > 0) {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        printReport(await settle({ ...s, thresholdSat: threshold, publicUrl: v['public-url'] }));
      } catch (e) {
        console.error('settle failed:', (e as Error).message);
      } finally {
        busy = false;
      }
    }, every * 1000).unref();
  }
} else if (cmd === 'settle') {
  const s = await settler();
  printReport(await settle({ ...s, thresholdSat: Number(v.threshold), publicUrl: v['public-url'] }, { force: v.force }));
  const r = s.ledger.reconcile();
  console.log(`books ${r.owedMsat} msat owed, wallet ${r.walletMsat} msat: ${r.ok ? 'match' : 'MISMATCH'}`);
} else if (cmd === 'ledger') {
  const s = await settler();
  const d = ledgerJson(s.ledger, s.show);
  for (const r of d.recipients) {
    console.log(`${r.name.padEnd(24)} credited ${(r.credited_msat / 1000).toFixed(3).padStart(10)}  paid ${String(r.paid_sats).padStart(7)}  owed ${(r.owed_msat / 1000).toFixed(3).padStart(10)}  ${r.reachable ? '' : 'unpayable by mint (keysend)'}`);
  }
  console.log(`received ${d.totals.received_sats} sat, paid ${d.totals.paid_sats} sat, books ${d.reconcile.ok ? 'match' : 'do NOT match'} the wallet`);
} else if (cmd === 'feed-line') {
  if (!v['public-url'] || !v['podcast-guid']) die('--public-url and --podcast-guid are required');
  console.log(feedLine(feedPaymentRequest(`${v['public-url']!.replace(/\/+$/, '')}/pay/${v['podcast-guid']}`, v.title)));
} else if (cmd === 'pay') {
  if (!v.creq || !v.sats || !v.mint?.[0]) die('--creq, --mint and --sats are required');
  const mintUrl = v.mint![0];
  if (!isTestMint(mintUrl)) die('pay is a test listener: test mints only');
  mkdirSync(v.data!, { recursive: true });
  const file = join(v.data!, `listener-${new URL(mintUrl).hostname}.json`);
  const wallet = new Wallet(mintUrl);
  await wallet.loadMint();
  let proofs: Proof[] = existsSync(file) ? deserializeProofs(JSON.parse(readFileSync(file, 'utf8'))) : [];
  const save = () => writeFileSync(file, JSON.stringify(serializeProofs(proofs)), { mode: 0o600 });
  if (v.fund) {
    const q = await wallet.createMintQuoteBolt11(Number(v.fund));
    for (let i = 0; i < 20 && (await wallet.checkMintQuoteBolt11(q.quote)).state !== MintQuoteState.PAID; i++) await new Promise((r) => setTimeout(r, 500));
    proofs = [...proofs, ...(await wallet.mintProofsBolt11(Number(v.fund), q.quote))];
    save();
  }
  const r = await payShow({ creq: v.creq!, wallet, proofs, sats: Number(v.sats), episodeGuid: v.episode,
    action: v.stream ? 'stream' : 'boost', ts: v.ts ? Number(v.ts) : undefined, memo: v.msg });
  proofs = r.proofs;
  save();
  console.log(`HTTP ${r.status} ${JSON.stringify(r.body)}`);
  console.log(`listener wallet: ${proofs.reduce((s, p) => s + p.amount.toNumber(), 0)} sat left at ${mintUrl}`);
} else {
  die(HELP);
}
