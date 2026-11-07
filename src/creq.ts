// The `<podcast:txt purpose="cashu">` feed record of CASHU_STREAMING.md
// Route B: a NUT-18 payment request built for a feed rather than a QR code.
// No amount (the app decides), not single-use (one record for every
// listener), unit sat, one POST transport, and no mint list (the app learns
// it from the `untrusted_mint` answer, as the document recommends).
import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';

export function feedPaymentRequest(postUrl: string, description?: string): string {
  const u = new URL(postUrl);
  if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
    throw new Error('the payment endpoint must be https');
  }
  const pr = new PaymentRequest(
    [{ type: PaymentRequestTransportType.POST, target: postUrl, tags: [] }],
    undefined, // id
    undefined, // amount: the app decides
    'sat',
    undefined, // mints: learned from untrusted_mint
    description,
    false, // not single-use
  );
  return pr.toEncodedCreqA();
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function feedLine(creq: string): string {
  return `<podcast:txt purpose="cashu">${escapeXml(creq)}</podcast:txt>`;
}

export function decodeFeedRequest(creq: string): { transport: Array<{ type: string; target: string }>; amount?: number; unit?: string; singleUse: boolean; mints?: string[]; description?: string } {
  const pr = PaymentRequest.fromEncodedRequest(creq);
  return {
    transport: (pr.transport ?? []).map((t) => ({ type: String(t.type), target: t.target })),
    amount: pr.amount?.toNumber(),
    unit: pr.unit,
    singleUse: pr.singleUse,
    mints: pr.mints,
    description: pr.description,
  };
}
