#!/usr/bin/env node
// A stand-in dev server with hot reload's kind of websocket, in plain
// node:http and crypto (no packages), for radial serve's preview proxy:
//   GET /        a page that says which port served it
//   GET /echo    the request as the server saw it (method, path, Host, Cookie), as JSON
//   upgrade      a websocket that echoes each text message back, with the
//                path and Cookie the upgrade came with, as JSON
// Run as a site's dev script (`node server.cjs`, PORT from the environment),
// or required, for attachEcho(server) on a test's own server.
'use strict';
const http = require('http');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One unmasked text frame (server to client). */
function frame(text) {
  const body = Buffer.from(text, 'utf8');
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

/** Reads one masked client frame's text from the start of buf, or null when it isn't all there yet. */
function readFrame(buf) {
  if (buf.length < 2) return null;
  let len = buf[1] & 127, at = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); at = 4; }
  const masked = (buf[1] & 128) !== 0;
  const mask = masked ? buf.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const body = Buffer.from(buf.subarray(at, at + len));
  if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return { opcode: buf[0] & 15, text: body.toString('utf8'), size: at + len };
}

/** Answers websocket upgrades on a server: each text message comes back as JSON with the path and Cookie the upgrade carried. */
function attachEcho(server, label) {
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    // /no-ws: not a websocket here. An ordinary answer on a connection left open, as some servers give, which a proxy mustn't join.
    if (req.url.startsWith('/no-ws')) { socket.write('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n'); socket.on('data', (d) => { server.emit('after-refusal', String(d)); }); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    // Its own cookie, and one posing as a radial proxy's pass (the proxy drops that one).
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: hmr_session=1; Path=/\r\nSet-Cookie: radial_pass_4001=forged; Path=/\r\n\r\n`);
    let pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const drain = () => {
      for (;;) {
        const f = readFrame(pending);
        if (!f) return;
        pending = pending.subarray(f.size);
        if (f.opcode === 8) { socket.end(); return; } // close
        if (f.opcode === 1) socket.write(frame(JSON.stringify({ echo: f.text, path: req.url, cookie: req.headers.cookie || null, server: label || null })));
      }
    };
    socket.on('data', (d) => { pending = Buffer.concat([pending, d]); drain(); });
    socket.on('error', () => {});
    drain();
  });
}

/** The page and the echo, as a dev server answers them. */
function handle(req, res, port) {
  if (req.url === '/echo' || req.url.startsWith('/echo?')) {
    // Its own cookie, and one that tries to pass for a radial proxy's (the proxy drops that one).
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['site_session=from-the-site; Path=/', 'radial_pass_4001=forged; Path=/'] });
    res.end(JSON.stringify({ method: req.method, path: req.url, host: req.headers.host || null, cookie: req.headers.cookie || null, port }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>Dev</title></head><body><h1>Hello from the dev server</h1><p id="port">${port}</p></body></html>`);
}

module.exports = { attachEcho, frame, readFrame, handle };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer((req, res) => handle(req, res, port));
  attachEcho(server, String(port));
  server.listen(port, '127.0.0.1', () => console.log('Listening on http://127.0.0.1:' + port + '/'));
}
