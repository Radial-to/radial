/**
 * Whether anything answers on a unix socket file, asked before a server takes
 * the path. A socket left by a process that died refuses connections and can be
 * replaced; a live one answers, and belongs to the process listening there. The
 * control server (cliServer.ts) and the PTY daemon (term-daemon.ts) both ask
 * before they listen, so a second process on the same data dir never takes a
 * running one's socket (plans/headless-core.md, risk 4). Pure Node.
 */
import net from 'net';

/**
 * What a probe found: 'live' when a server accepts the connection, 'dead' when
 * nothing listens there (a socket left by a process that died, a file that
 * isn't a socket, or no file now), else the error that says neither.
 */
export type SocketProbe = 'live' | 'dead' | NodeJS.ErrnoException;

export function probeSocket(socketPath: string, timeoutMs = 1000): Promise<SocketProbe> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    // A listening server accepts at once, however busy it is; a connection left pending this long still means someone is there.
    const timer = setTimeout(() => done('live'), timeoutMs);
    function done(found: SocketProbe): void { clearTimeout(timer); sock.destroy(); resolve(found); }
    sock.once('connect', () => done('live'));
    sock.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK' || e.code === 'ENOENT' ? 'dead' : e));
  });
}
