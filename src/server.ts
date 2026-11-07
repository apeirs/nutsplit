// HTTP: the NUT-18 intake, the feed record, the public ledger and a
// capability document, on node:http with no framework.
//
//   POST /pay/<podcast_guid>[?episode=<item guid>&action=stream|boost&ts=<s>]
//   GET  /creq/<podcast_guid>          the creqA + the <podcast:txt> line
//   GET  /ledger/<podcast_guid>        HTML, or JSON with ?format=json / Accept
//   GET  /shows/<podcast_guid>/ecash   capability JSON (Listener API v1 shape)
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { PaymentRequest } from '@cashu/cashu-ts';
import { feedLine, feedPaymentRequest } from './creq.ts';
import { receivePayment } from './intake.ts';
import { ledgerHtml, ledgerJson } from './report.ts';
import { toStored, type MintClient } from './mint.ts';
import type { Show } from './accrue.ts';
import type { Ledger } from './ledger.ts';

export interface ServerOptions {
  ledger: Ledger;
  shows: Show[];
  mints: MintClient[];
  /** Public base URL, used in the payment request; default from the Host header. */
  publicUrl?: string;
  /** Requests per minute per IP on /pay, as Sovereigncast's 10/min; 0 = off. */
  rateLimitPerMin?: number;
  log?: (line: string) => void;
}

const MAX_BODY = 256 * 1024;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    ...CORS, ...headers,
  });
  res.end(text);
}

/** Listener API v1 error shape (Hopp ADR 0010): {"error": {"code", "message"}}. */
function err(res: ServerResponse, status: number, code: string, message: string) {
  send(res, status, { error: { code, message } });
}

/** /pay answers exactly like Sovereigncast's ecash-payment, so one app handles both. */
function payErr(res: ServerResponse, status: number, code: string, extra: Record<string, unknown> = {}) {
  send(res, status, { success: false, error: code, ...extra });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new Error('too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createNutsplitServer(o: ServerOptions): Server {
  const hits = new Map<string, number[]>();
  const limited = (ip: string) => {
    const per = o.rateLimitPerMin ?? 10;
    if (!per) return false;
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(ip, list);
    return list.length > per;
  };
  const showOf = (guid: string) => o.shows.find((s) => s.podcastGuid === guid);
  const base = (req: IncomingMessage) => (o.publicUrl ?? `http://${req.headers.host}`).replace(/\/+$/, '');

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');

      if (req.method === 'POST' && parts[0] === 'pay' && parts.length === 2) {
        const show = showOf(parts[1]);
        if (!show) return payErr(res, 404, 'unknown_show');
        if (limited(req.socket.remoteAddress ?? '')) return payErr(res, 429, 'rate_limited');
        let payload;
        try {
          payload = PaymentRequest.decodePayload(await readBody(req));
        } catch {
          return payErr(res, 400, 'invalid_payload');
        }
        const action = url.searchParams.get('action') === 'stream' ? 'stream' : 'boost';
        const tsRaw = url.searchParams.get('ts');
        const ts = tsRaw !== null && tsRaw !== '' && Number.isFinite(Number(tsRaw)) ? Number(tsRaw) : undefined;
        const r = await receivePayment({ ledger: o.ledger, show, mints: o.mints }, {
          mint: payload.mint, unit: payload.unit, proofs: toStored(payload.proofs), memo: payload.memo?.slice(0, 300),
          episodeGuid: url.searchParams.get('episode') || undefined, kind: action, ts, rail: 'nut18',
        });
        o.log?.(`pay ${show.podcastGuid.slice(0, 8)} ${action} ${r.ok ? r.body.amount_sats + ' sat' : r.body.error}`);
        return send(res, r.status, r.body);
      }

      if (req.method === 'GET' && parts[0] === 'creq' && parts.length === 2) {
        const show = showOf(parts[1]);
        if (!show) return err(res, 404, 'unknown_show', 'no such podcast guid here');
        const creq = feedPaymentRequest(`${base(req)}/pay/${show.podcastGuid}`, show.feed.title);
        return send(res, 200, { request: creq, feed_line: feedLine(creq) });
      }

      if (req.method === 'GET' && parts[0] === 'shows' && parts[2] === 'ecash' && parts.length === 3) {
        const show = showOf(parts[1]);
        if (!show) return err(res, 404, 'unknown_show', 'no such podcast guid here');
        const creq = feedPaymentRequest(`${base(req)}/pay/${show.podcastGuid}`, show.feed.title);
        return send(res, 200, { ecash: { nut18: creq, split_settlement: true, accepted_mints: o.mints.map((m) => m.mintUrl),
          ledger_url: `${base(req)}/ledger/${show.podcastGuid}` } });
      }

      if (req.method === 'GET' && parts[0] === 'ledger' && parts.length === 2) {
        const show = showOf(parts[1].replace(/\.json$/, ''));
        if (!show) return err(res, 404, 'unknown_show', 'no such podcast guid here');
        const data = ledgerJson(o.ledger, show);
        const wantJson = url.searchParams.get('format') === 'json' || parts[1].endsWith('.json')
          || (req.headers.accept ?? '').startsWith('application/json');
        const body = wantJson ? JSON.stringify(data) : ledgerHtml(data);
        const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, ...CORS }); return res.end(); }
        res.writeHead(200, { 'content-type': wantJson ? 'application/json' : 'text/html; charset=utf-8', etag, 'cache-control': 'no-cache', ...CORS });
        return res.end(body);
      }

      return err(res, 404, 'not_found', 'no such endpoint');
    } catch (e) {
      o.log?.(`error ${req.method} ${url.pathname}: ${(e as Error).message}`);
      // Sovereigncast: "a 500 should be treated as retryable; hold the proofs".
      if (!res.headersSent) payErr(res, 500, 'server_error');
    }
  });
}
