// A Nostr relay on 127.0.0.1 for tests and the demo: NIP-01 REQ/EVENT/CLOSE
// over a minimal RFC 6455 WebSocket server on node:http. It keeps events in
// memory, matches kinds/authors/since/until/#tag filters, and can drop every
// connection to test reconnects. Nothing here talks to a public relay.
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { Filter, NostrEvent } from '../src/nostr.ts';

export interface LocalRelay {
  url: string;
  events: NostrEvent[];
  /** Every REQ the relay got, as [subId, ...filters]. */
  reqs: unknown[][];
  publish(e: NostrEvent): void;
  /** Drop every client connection (they should reconnect). */
  kick(): void;
  close(): Promise<void>;
}

export function matches(f: Filter, e: NostrEvent): boolean {
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const [k, vals] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(vals)) continue;
    const name = k.slice(1);
    if (!e.tags.some((t) => t[0] === name && vals.includes(t[1]))) return false;
  }
  return true;
}

function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => {
    const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b;
  })();
  return Buffer.concat([head, body]);
}

export async function startLocalRelay(): Promise<LocalRelay> {
  const events: NostrEvent[] = [];
  const reqs: unknown[][] = [];
  const clients = new Set<{ socket: Socket; subs: Map<string, Filter[]> }>();
  const server: Server = createServer((_, res) => { res.writeHead(426); res.end(); });

  const send = (socket: Socket, msg: unknown[]) => { if (!socket.destroyed) socket.write(frame(JSON.stringify(msg))); };
  const deliver = (e: NostrEvent) => {
    for (const c of clients) for (const [id, fs] of c.subs) if (fs.some((f) => matches(f, e))) send(c.socket, ['EVENT', id, e]);
  };

  server.on('upgrade', (req, socket: Socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = { socket, subs: new Map<string, Filter[]>() };
    clients.add(client);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = (buf[1] & 0x80) !== 0;
        const mask = masked ? buf.subarray(off, off + 4) : undefined;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (op === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
        if (op !== 1) continue;
        let msg: any;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (msg[0] === 'REQ') {
          reqs.push(msg.slice(1));
          const fs = msg.slice(2) as Filter[];
          client.subs.set(msg[1], fs);
          for (const e of events) if (fs.some((f) => matches(f, e))) send(socket, ['EVENT', msg[1], e]);
          send(socket, ['EOSE', msg[1]]);
        } else if (msg[0] === 'CLOSE') {
          client.subs.delete(msg[1]);
        } else if (msg[0] === 'EVENT' && msg[1]?.id) {
          if (!events.some((e) => e.id === msg[1].id)) { events.push(msg[1]); deliver(msg[1]); }
          send(socket, ['OK', msg[1].id, true, '']);
        }
      }
    });
    const drop = () => clients.delete(client);
    socket.on('close', drop);
    socket.on('error', drop);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    events,
    reqs,
    publish(e) {
      if (events.some((x) => x.id === e.id)) { deliver(e); return; }
      events.push(e);
      deliver(e);
    },
    kick() {
      for (const c of clients) c.socket.destroy();
      clients.clear();
    },
    close: () => new Promise((r) => {
      for (const c of clients) c.socket.destroy();
      server.close(() => r());
    }),
  };
}
