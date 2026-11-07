// Test helpers: unsigned look-alike invoices and a stub LNURL session.
import { bech32 } from '@scure/base';
import { randomBytes } from 'node:crypto';

/** A bolt11-shaped invoice for `sat` (signature words are zeros: nutsplit does not check them). */
export function fakeInvoice(sat: number, hash = randomBytes(32)): string {
  const ts = Math.floor(Date.now() / 1000);
  const tsWords: number[] = [];
  for (let i = 6, t = ts; i >= 0; i--) { tsWords[i] = t % 32; t = Math.floor(t / 32); }
  const words = [...tsWords, 1, 1, 20, ...bech32.toWords(hash), ...new Array(104).fill(0)];
  return bech32.encode(`lnbc${sat * 10}n`, words, false);
}

/** Stands in for fetch: answers the .well-known lookup and the callback, records URLs. */
export function stubFetch(wellKnown: unknown, invoice: unknown, status = 200) {
  const urls: string[] = [];
  const f = (async (url: string | URL) => {
    const u = String(url);
    urls.push(u);
    const body = JSON.stringify(u.includes('.well-known') ? wellKnown : invoice);
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, urls };
}
