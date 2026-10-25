'use strict';
// The hook Radial gives the CLIs its chats start (chat/interactive.ts writes
// the command). It journals every event for the chat, and on Claude Code's
// PreToolUse it refuses the Bash commands devGuard forbids: a second dev
// server, deleting the build folder, killing the preview's server. Otherwise it
// never approves, denies, or changes a tool. It runs on every tool call, so it
// stays small and loads nothing beyond Node's own modules and the guard.
//   observe.cjs <journal> [<the project's .radial/dev.json>]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [journal, devInfo] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { input += data; if (input.length > 8 * 1024 * 1024) process.exit(0); });
process.stdin.on('end', () => {
  let event = null;
  try { event = JSON.parse(input); delete event.user_email; fs.appendFileSync(journal, JSON.stringify(event) + '\n', { mode: 0o600 }); } catch {}
  process.stdout.write(JSON.stringify(refusal(event) || {}));
});

// Claude Code's documented answer for a PreToolUse hook that blocks the call:
// the reason goes to the agent, which runs `radial restart --yes` instead. The
// guard is devGuard's compiled module, copied beside this file; without it (or
// on any error) the call goes ahead, as it would with no hook.
function refusal(event) {
  if (!event || event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'Bash') return null;
  try {
    const { forbiddenBashReason } = require(path.join(__dirname, 'devGuard.cjs'));
    const reason = forbiddenBashReason(event.tool_input && event.tool_input.command, { devServerPids: serverPids });
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : null;
  } catch { return null; }
}

// The preview's dev server: the pid dev.json records (Radial's server, one it
// adopted, or Radial itself for a static site) and the rest of its process
// group, since a server's workers have pids of their own. devGuard asks only
// when a command kills something.
function serverPids() {
  const pids = new Set();
  let pid = 0;
  try { pid = Number(JSON.parse(fs.readFileSync(devInfo, 'utf8')).pid); } catch {}
  if (!(pid > 0)) return pids;
  pids.add(pid);
  try {
    const rows = execFileSync('ps', ['axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 3000 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const group = (rows.find(([p]) => p === pid) || [])[1];
    if (group > 0) for (const [p, g] of rows) if (g === group) pids.add(p);
  } catch {}
  return pids;
}
