/**
 * Headless one-shot runs of the user's own Claude Code CLI (`claude -p`).
 * This is the BYO-auth replacement for the agent SDK's query(): same auth,
 * same binary the terminal pane runs, no SDK dependency.
 *
 * POLICY: only ever called from an explicit user action (the commit-message
 * draft button, SEO meta/alt suggestions, rule Enhance/Audit) — never from
 * background work. Background commits derive their messages deterministically
 * (publish.subjectFromStatus) so Radial never spends the user's subscription
 * quota without them asking. Keep it that way: unattended programmatic use of
 * subscription auth is the pattern provider terms prohibit.
 *
 * The prompt goes over stdin (never argv — diffs blow past sane arg lengths
 * and quoting). Every call is read-only: there is deliberately no permission
 * flag here, so a headless run can never edit files or run commands.
 */

import { spawn } from 'child_process';
import { childEnv, claudeBin } from './env';

/** runPrint()'s options: the model to ask for, how long to wait, and a CLI to run instead of the user's `claude`. */
export interface RunPrintOptions { model?: string; timeoutMs?: number; bin?: string | null }
/** runPrint()'s answer: the trimmed reply, or why there is none ('claude-cli-not-found', 'timeout', the CLI's stderr). */
export type RunPrintResult = { ok: true; text: string } | { ok: false; error: string };

function runPrint(repoDir: string, prompt: string, { model, timeoutMs = 120000, bin = null }: RunPrintOptions = {}): Promise<RunPrintResult> {
  return new Promise((resolve) => {
    const exe = bin || claudeBin();
    if (!exe) { resolve({ ok: false, error: 'claude-cli-not-found' }); return; }
    const args = ['-p', '--output-format', 'text'];
    if (model) args.push('--model', model);
    let child;
    try { child = spawn(exe, args, { cwd: repoDir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ ok: false, error: (e as Error).message }); return; }
    let out = '', err = '', done = false;
    const finish = (res: RunPrintResult) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out += d; });
    child.stderr.on('data', (d: Buffer) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('exit', (code) => {
      finish(code === 0
        ? { ok: true, text: String(out).trim() }
        : { ok: false, error: (String(err).trim() || String(out).trim() || `exit ${code}`).slice(0, 400) });
    });
    child.stdin.on('error', () => {}); // CLI may exit before reading stdin
    child.stdin.end(prompt);
  });
}

export { runPrint };
