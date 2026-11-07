// A local stand-in for the recipients' Lightning-address providers. It
// answers LNURL-pay for a fixed set of users on 127.0.0.1 and issues every
// invoice from a test mint (testnut.cashudevkit.org), whose Lightning is
// simulated. No real provider, account or invoice is ever involved.
import { createServer, type Server } from 'node:http';

export interface StubPayment {
  user: string;
  amountMsat: number;
  comment?: string;
  quote: string;
  invoice: string;
}

export interface LnurlStub {
  server: Server;
  port: number;
  received: StubPayment[];
  urlFor: (user: string, domain: string, address: string) => string;
  isSafeUrl: (url: string) => Promise<boolean>;
  close: () => Promise<void>;
}

export async function startLnurlStub(opts: {
  /** Real address in the feed → stub user name. Only these resolve. */
  addresses: Record<string, string>;
  invoiceMint: string;
  commentAllowed?: number;
}): Promise<LnurlStub> {
  const received: StubPayment[] = [];
  const users = new Set(Object.values(opts.addresses));
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const m = /^\/\.well-known\/lnurlp\/([a-z0-9._-]+)$/.exec(u.pathname);
    if (m) {
      if (!users.has(m[1])) return json(404, { status: 'ERROR', reason: 'unknown user' });
      return json(200, {
        tag: 'payRequest', callback: `http://127.0.0.1:${port}/cb/${m[1]}`, minSendable: 1000, maxSendable: 1_000_000_000,
        metadata: JSON.stringify([['text/plain', `stand-in for ${m[1]}`]]), commentAllowed: opts.commentAllowed ?? 255,
      });
    }
    const c = /^\/cb\/([a-z0-9._-]+)$/.exec(u.pathname);
    if (c && users.has(c[1])) {
      const amountMsat = Number(u.searchParams.get('amount'));
      if (!Number.isSafeInteger(amountMsat) || amountMsat < 1000 || amountMsat % 1000) return json(200, { status: 'ERROR', reason: 'whole sats only' });
      try {
        const r = await fetch(`${opts.invoiceMint}/v1/mint/quote/bolt11`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amount: amountMsat / 1000, unit: 'sat' }), signal: AbortSignal.timeout(15_000),
        });
        const q = await r.json() as { quote: string; request: string };
        received.push({ user: c[1], amountMsat, comment: u.searchParams.get('comment') ?? undefined, quote: q.quote, invoice: q.request });
        return json(200, { pr: q.request, routes: [] });
      } catch (e) {
        return json(200, { status: 'ERROR', reason: `invoice mint unreachable: ${(e as Error).message}` });
      }
    }
    return json(404, { status: 'ERROR', reason: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const prefix = `http://127.0.0.1:${port}/`;
  return {
    server, port, received,
    urlFor: (_user, _domain, address) => {
      const stub = opts.addresses[address.toLowerCase()];
      // The safety line: a real Lightning address is never contacted from the demo.
      if (!stub) throw new Error(`demo: ${address} has no local stand-in, refusing to contact it`);
      return `${prefix}.well-known/lnurlp/${stub}`;
    },
    isSafeUrl: async (url) => url.startsWith(prefix),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
