// Just enough BOLT11 decoding to check an invoice before paying it: the
// network, the amount and the payment hash. No signature check: what protects
// a payout is that the amount is exactly the share (Hopp audits M-04/M-06),
// and the mint's melt quote must agree on it too.
import { bech32 } from '@scure/base';

export interface Bolt11Info {
  network: string;
  amountMsat?: number;
  paymentHash?: string;
  timestamp: number;
  expirySec: number;
  description?: string;
}

const MULT: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n, p: 0n };

export function decodeBolt11(invoice: string): Bolt11Info {
  const inv = invoice.trim().toLowerCase().replace(/^lightning:/, '');
  const { prefix, words } = bech32.decode(inv as `${string}1${string}`, false);
  const m = /^ln(bcrt|bc|tbs|tb|sb)(\d+)?([munp])?$/.exec(prefix);
  if (!m) throw new Error(`not a bolt11 invoice (prefix ${prefix})`);
  let amountMsat: number | undefined;
  if (m[2]) {
    const n = BigInt(m[2]);
    let msat: bigint;
    if (!m[3]) msat = n * 100_000_000_000n;
    else if (m[3] === 'p') {
      if (n % 10n !== 0n) throw new Error('pico amount not a whole millisat');
      msat = n / 10n;
    } else msat = n * MULT[m[3]];
    if (msat > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount too large');
    amountMsat = Number(msat);
  }
  if (words.length < 7 + 104) throw new Error('invoice too short');
  const data = words.slice(0, words.length - 104); // strip the signature
  let timestamp = 0;
  for (let i = 0; i < 7; i++) timestamp = timestamp * 32 + data[i];
  let paymentHash: string | undefined;
  let description: string | undefined;
  let expirySec = 3600;
  let i = 7;
  while (i + 3 <= data.length) {
    const type = data[i];
    const len = data[i + 1] * 32 + data[i + 2];
    const field = data.slice(i + 3, i + 3 + len);
    i += 3 + len;
    if (field.length < len) throw new Error('truncated tagged field');
    if (type === 1 && len === 52) paymentHash = Buffer.from(bech32.fromWords(field)).toString('hex');
    else if (type === 13) description = Buffer.from(bech32.fromWordsUnsafe(field) ?? []).toString('utf8');
    else if (type === 6) expirySec = field.reduce((a, w) => a * 32 + w, 0);
  }
  return { network: m[1], amountMsat, paymentHash, timestamp, expirySec, description };
}
