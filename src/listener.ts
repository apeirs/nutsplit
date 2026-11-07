// The listener's side of Route B: read the feed's `purpose="cashu"` payment
// request, send ecash to its POST transport. What a podcast app would do;
// used by the CLI's `pay` command and by the demo.
import { PaymentRequest, PaymentRequestTransportType, type Wallet, type Proof } from '@cashu/cashu-ts';

export interface PayArgs {
  creq: string;
  wallet: Wallet;
  proofs: Proof[];
  sats: number;
  episodeGuid?: string;
  action: 'stream' | 'boost';
  ts?: number;
  memo?: string;
  fetch?: typeof fetch;
}

export interface PayResult {
  status: number;
  body: any;
  /** What the listener's wallet holds afterwards. */
  proofs: Proof[];
}

export function paymentUrl(creq: string, q: { episodeGuid?: string; action: 'stream' | 'boost'; ts?: number }): string {
  const pr = PaymentRequest.fromEncodedRequest(creq);
  const post = pr.getTransport(PaymentRequestTransportType.POST);
  if (!post) throw new Error('payment request has no POST transport');
  const u = new URL(post.target);
  // CASHU_STREAMING.md: ?action=stream for streaming, nothing for a boost.
  if (q.action === 'stream') u.searchParams.set('action', 'stream');
  if (q.episodeGuid) u.searchParams.set('episode', q.episodeGuid);
  if (q.ts !== undefined) u.searchParams.set('ts', String(Math.floor(q.ts)));
  return u.toString();
}

export async function payShow(a: PayArgs): Promise<PayResult> {
  const pr = PaymentRequest.fromEncodedRequest(a.creq);
  const { keep, send } = await a.wallet.send(a.sats, a.proofs);
  const body = pr.encodePayload(a.wallet.mint.mintUrl, send, { memo: a.memo, unit: 'sat' });
  const res = await (a.fetch ?? fetch)(paymentUrl(a.creq, a), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  // Sovereigncast's table: success and already_* mean the payment arrived;
  // anything else, the listener keeps the proofs.
  const arrived = res.ok || json?.error === 'already_redeemed' || json?.error === 'already_spent';
  return { status: res.status, body: json, proofs: arrived ? keep : [...keep, ...send] };
}
