// LNURL-pay for Lightning-address recipients. A port of Sovereigncast's
// `_lnurl_invoice_for_address` (community.py), with the invoice amount check
// Hopp applies before paying (audits M-04/M-06) and the size limit of M-02.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { decodeBolt11 } from './bolt11.ts';

export interface LnurlDeps {
  fetch?: typeof fetch;
  /**
   * Where a Lightning address's LNURL-pay document lives. Default
   * `https://<domain>/.well-known/lnurlp/<user>`. The demo maps its stand-in
   * addresses to a local stub here, and refuses every other address.
   */
  urlFor?: (user: string, domain: string, address: string) => string;
  /** Default: https only, and the host must resolve to public addresses only. */
  isSafeUrl?: (url: string) => Promise<boolean>;
  timeoutMs?: number;
}

export interface LnurlResult {
  invoice?: string;
  error?: string;
  /** Whether the memo actually went along (LUD-12 comment); false = report `no_memo`. */
  memoCarried: boolean;
  paymentHash?: string;
}

export const LNURL_MAX_BYTES = 512 * 1024;

/** `?` or `&`, then urlencoded params (spaces as `+`, like Python's urlencode). */
export function appendQuery(url: string, params: Record<string, string | number>): string {
  const sep = new URL(url).search ? '&' : '?';
  return url + sep + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
}

/**
 * LUD-18 payer identity, only when the provider asks for it. Only `name` is
 * offered; a provider that makes any field we do not supply mandatory
 * (`auth`, `email` …) gets no payerdata at all.
 */
export function lnurlPayerData(data: any, senderName: string): string | undefined {
  const spec = data?.payerData;
  if (!spec || typeof spec !== 'object' || !senderName) return undefined;
  if (spec.auth && typeof spec.auth === 'object' && spec.auth.mandatory) return undefined;
  for (const [field, value] of Object.entries(spec)) {
    if (field === 'name' || field === 'auth') continue;
    if (value && typeof value === 'object' && (value as any).mandatory) return undefined;
  }
  if (!('name' in spec)) return undefined;
  return JSON.stringify({ name: senderName.slice(0, 64) });
}

function privateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8')
    || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** https, and every address the host resolves to is public. */
export async function isPublicHttpsUrl(url: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateIp(a.address));
  } catch {
    return false;
  }
}

async function getJson(url: string, deps: LnurlDeps): Promise<{ status: number; json?: any }> {
  const f = deps.fetch ?? fetch;
  const res = await f(url, { redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    headers: { accept: 'application/json' } });
  const declared = Number(res.headers?.get?.('content-length') ?? 0);
  if (declared > LNURL_MAX_BYTES) throw new Error('response too large');
  const text = await res.text();
  if (text.length > LNURL_MAX_BYTES) throw new Error('response too large');
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json };
}

/**
 * A bolt11 invoice for exactly `amountSat` from a Lightning address, or the
 * reason there is none. One of `invoice` and `error` is set: an unreachable
 * recipient becomes a skipped (and shown) share, never an exception.
 */
export async function lnurlInvoice(address: string, amountSat: number, comment: string, senderName: string,
  deps: LnurlDeps = {}): Promise<LnurlResult> {
  const at = address.lastIndexOf('@');
  const user = at > 0 ? address.slice(0, at).trim() : '';
  const domain = at > 0 ? address.slice(at + 1).trim() : '';
  if (!user || !domain) return { error: 'invalid address', memoCarried: false };
  const amountMsat = amountSat * 1000;
  const isSafe = deps.isSafeUrl ?? isPublicHttpsUrl;

  let lnurlpUrl: string;
  try {
    lnurlpUrl = (deps.urlFor ?? ((u, d) => `https://${d}/.well-known/lnurlp/${encodeURIComponent(u)}`))(user, domain, address);
  } catch (e) {
    return { error: (e as Error).message, memoCarried: false };
  }
  if (!(await isSafe(lnurlpUrl))) return { error: 'not a public address', memoCarried: false };
  let data: any;
  try {
    const r = await getJson(lnurlpUrl, deps);
    if (r.status !== 200) return { error: `provider unreachable (HTTP ${r.status})`, memoCarried: false };
    data = r.json;
  } catch (e) {
    return { error: `provider unreachable (${(e as Error).message})`, memoCarried: false };
  }
  if (!data || typeof data !== 'object') return { error: 'provider unreachable (not JSON)', memoCarried: false };
  if (data.status === 'ERROR') return { error: data.reason ?? 'LNURL error', memoCarried: false };
  const callback = typeof data.callback === 'string' ? data.callback : '';
  if (!callback) return { error: 'no callback in LNURL response', memoCarried: false };

  // The share is fixed by the split: an amount out of the provider's bounds
  // is reported, never nudged into range.
  const minSendable = Number(data.minSendable || 1000);
  const maxSendable = Number(data.maxSendable || 100_000_000_000);
  if (amountMsat < minSendable) return { error: `share below the minimum (${Math.floor(minSendable / 1000)} sats)`, memoCarried: false };
  if (amountMsat > maxSendable) return { error: `share above the maximum (${Math.floor(maxSendable / 1000)} sats)`, memoCarried: false };

  const params: Record<string, string | number> = { amount: amountMsat };
  const commentAllowed = Math.max(0, Math.trunc(Number(data.commentAllowed || 0)));
  const memoCarried = Boolean(commentAllowed && comment);
  if (memoCarried) params.comment = [...comment].slice(0, commentAllowed).join('');
  const payerData = lnurlPayerData(data, senderName);
  if (payerData) params.payerdata = payerData;
  let callbackUrl: string;
  try { callbackUrl = appendQuery(callback, params); } catch { return { error: 'bad callback URL', memoCarried: false }; }
  if (!(await isSafe(callbackUrl))) return { error: 'LNURL callback is not a public address', memoCarried: false };

  let inv: any;
  try {
    const r = await getJson(callbackUrl, deps);
    if (r.status !== 200) return { error: `invoice request failed (HTTP ${r.status})`, memoCarried: false };
    inv = r.json;
  } catch (e) {
    return { error: `invoice request failed (${(e as Error).message})`, memoCarried: false };
  }
  if (!inv || typeof inv !== 'object') return { error: 'no invoice in response', memoCarried: false };
  if (inv.status === 'ERROR') return { error: inv.reason ?? 'invoice error', memoCarried: false };
  const invoice = String(inv.pr ?? inv.invoice ?? '').trim();
  if (!invoice) return { error: 'no invoice in response', memoCarried: false };

  // Paid only if it asks for exactly the share.
  let decoded;
  try { decoded = decodeBolt11(invoice); } catch (e) { return { error: `unreadable invoice (${(e as Error).message})`, memoCarried: false }; }
  if (decoded.amountMsat !== amountMsat) {
    return { error: `invoice amount ${decoded.amountMsat ?? 'none'} msat is not the share (${amountMsat} msat)`, memoCarried: false };
  }
  return { invoice, memoCarried, paymentHash: decoded.paymentHash };
}
