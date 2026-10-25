import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditUI } from './ui-audit.mts';
import { compile } from './transpile.mts';

const root = fileURLToPath(new URL('../', import.meta.url));
const types: Partial<Record<string, string>> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
export function createLibraryServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/ui-audit.json' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(await auditUI())); return;
      }
      const requested = url.pathname === '/' ? 'src/renderer/ui/index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(root, requested);
      const allowed = ['src/renderer/', 'docs/design/'].some((prefix) => file.startsWith(path.resolve(root, prefix) + path.sep));
      if (!allowed || !['GET', 'HEAD'].includes(req.method!)) { res.writeHead(403); res.end('Not available'); return; }
      // A page script written in TypeScript is compiled as it's served.
      const source = file.endsWith('.js') ? await fs.access(file).then(() => file, () => file.replace(/\.js$/, '.ts')) : file;
      const real = await fs.realpath(source);
      if (real !== source) { res.writeHead(403); res.end('Not available'); return; }
      const body = source === file ? await fs.readFile(file)
        : compile(path.relative(path.join(root, 'src'), source).split(path.sep).join('/'), await fs.readFile(source, 'utf8'));
      res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'text/plain'}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.RADIAL_UI_PORT || 4318);
  const server = createLibraryServer();
  server.on('error', (error) => { console.error(`UI library: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Radial UI → http://127.0.0.1:${port}`));
}
