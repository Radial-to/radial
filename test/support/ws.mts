// A websocket client in plain node:net and crypto (no packages), for the
// preview proxy's tests: a raw upgrade, one masked text message, and the
// first text message back. test/fixtures/ws-dev-server.cjs is the server side.
import net from 'node:net';
import crypto from 'node:crypto';

/** How an upgrade went: the response's status, its head, and the first message back (null when it wasn't a 101). */
export interface WsResult { status: number; head: string; message: string | null }

/** One masked text frame (client to server). */
function frame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(body.map((b, i) => b ^ mask[i % 4]));
  const head = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, mask, masked]);
}

/**
 * Opens a websocket and leaves it open: the status and head of the answer,
 * the socket, and a promise that settles when the socket closes. A test then
 * sees whether something else (a sweep, a revoke) ends it.
 */
export function wsOpen(url: string, headers: Record<string, string> = {}, timeoutMs = 10000): Promise<{ status: number; head: string; socket: net.Socket; closed: Promise<void> }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port) || 80, u.hostname.replace(/^\[|\]$/g, ''));
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no websocket answer from ${url} within ${timeoutMs} ms`)); }, timeoutMs);
    let buf = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('connect', () => {
      const lines = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${headers.Host || u.host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13'];
      for (const [k, v] of Object.entries(headers)) if (k !== 'Host') lines.push(`${k}: ${v}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      clearTimeout(timer);
      const head = buf.subarray(0, end).toString('latin1');
      resolve({ status: Number(head.split(' ')[1]) || 0, head, socket, closed });
    };
    socket.on('data', onData);
  });
}

/** Opens a websocket at url (http:// or ws://) with a raw upgrade, sends text, and answers the status and the first text message back. */
export function wsRoundTrip(url: string, text: string, headers: Record<string, string> = {}, timeoutMs = 10000): Promise<WsResult> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port) || 80, u.hostname.replace(/^\[|\]$/g, ''));
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no websocket answer from ${url} within ${timeoutMs} ms`)); }, timeoutMs);
    const done = (r: WsResult) => { clearTimeout(timer); socket.destroy(); resolve(r); };
    let buf = Buffer.alloc(0), head: string | null = null, status = 0;
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
    socket.on('connect', () => {
      const lines = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${headers.Host || u.host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13'];
      for (const [k, v] of Object.entries(headers)) if (k !== 'Host') lines.push(`${k}: ${v}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (head === null) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        head = buf.subarray(0, end).toString('latin1');
        status = Number(head.split(' ')[1]) || 0;
        buf = buf.subarray(end + 4);
        if (status !== 101) { done({ status, head, message: null }); return; }
        socket.write(frame(text));
      }
      if (buf.length < 2) return;
      let len = buf[1] & 127, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      if (buf.length < at + len) return;
      done({ status, head, message: buf.subarray(at, at + len).toString('utf8') });
    });
    socket.on('close', () => { if (head === null) { clearTimeout(timer); reject(new Error(`the connection to ${url} closed before an answer`)); } });
  });
}
