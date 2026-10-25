import { test } from 'node:test';
import assert from 'node:assert';

import * as tools from '../src/main/tools';
import type { GhRelease, NodeDistEntry } from '../src/main/tools';

test('ghAssetUrl picks the macOS arm64 zip from a release', () => {
  const rel: GhRelease = {
    assets: [
      { name: 'gh_2.62.0_linux_amd64.tar.gz', browser_download_url: 'https://x/linux' },
      { name: 'gh_2.62.0_macOS_amd64.zip', browser_download_url: 'https://x/mac-intel' },
      { name: 'gh_2.62.0_macOS_arm64.zip', browser_download_url: 'https://x/mac-arm' },
    ],
  };
  assert.equal(tools.ghAssetUrl(rel), 'https://x/mac-arm');
  assert.equal(tools.ghAssetUrl(rel, 'amd64'), 'https://x/mac-intel');
  assert.equal(tools.ghAssetUrl({ assets: [] }), null);
  assert.equal(tools.ghAssetUrl(null), null);
});

test('nodeIndexPick takes the newest LTS entry (index is newest-first)', () => {
  const idx: NodeDistEntry[] = [
    { version: 'v23.5.0', lts: false },
    { version: 'v22.12.0', lts: 'Jod' },
    { version: 'v22.11.0', lts: 'Jod' },
    { version: 'v20.18.0', lts: 'Iron' },
  ];
  assert.equal(tools.nodeIndexPick(idx), '22.12.0');
  assert.equal(tools.nodeIndexPick([{ version: 'v23.0.0', lts: false }]), null);
  assert.equal(tools.nodeIndexPick([]), null);
  assert.equal(tools.nodeIndexPick(null), null);
});

test('parseGhAuthChunk finds the one-time code, device url, and Enter prompt', () => {
  const out = [
    '! First copy your one-time code: 1D2C-8A4F',
    'Press Enter to open https://github.com/login/device in your browser...',
  ].join('\n');
  const r = tools.parseGhAuthChunk(out);
  assert.equal(r.code, '1D2C-8A4F');
  assert.equal(r.url, 'https://github.com/login/device');
  assert.equal(r.wantsEnter, true);

  // Streaming reality: the code can arrive before the Enter prompt.
  const early = tools.parseGhAuthChunk('one-time code: ABCD-1234');
  assert.equal(early.code, 'ABCD-1234');
  assert.equal(early.wantsEnter, false);
  assert.equal(tools.parseGhAuthChunk('Logging in...').code, null);
});

test('parseGhAuthChunk spots the already-signed-in re-auth confirm', () => {
  const r = tools.parseGhAuthChunk('You\'re already logged into github.com as octocat. Do you want to re-authenticate? (y/N)');
  assert.equal(r.wantsReauth, true);
  assert.equal(tools.parseGhAuthChunk('one-time code: AAAA-1111').wantsReauth, false);
});

test('termQueryReplies answers OSC 11 and DSR once per query', () => {
  const chunk = '\x1b]11;?\x1b\\\x1b[6n\x1b]11;?\x1b\\\x1b[6n';
  const r = tools.termQueryReplies(chunk);
  assert.equal((r.match(/\x1b\]11;rgb:/g) || []).length, 2);
  assert.equal((r.match(/\x1b\[1;1R/g) || []).length, 2);
  assert.equal(tools.termQueryReplies('plain text'), '');
});

test('parseClaudeAuthChunk reads the onboarding prompts and the oauth url', () => {
  const theme = tools.parseClaudeAuthChunk('Choose the text style that looks best with your terminal:\n❯ Dark mode');
  assert.equal(theme.wantsTheme, true);
  assert.equal(theme.wantsMethod, false);

  const method = tools.parseClaudeAuthChunk('Select login method:\n❯ 1. Claude account with subscription\n  2. Anthropic Console account');
  assert.equal(method.wantsMethod, true);

  const url = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&scope=org';
  const opened = tools.parseClaudeAuthChunk(`Opening browser… ${url}\nPaste code here if prompted:`);
  assert.equal(opened.url, url);
  assert.equal(opened.wantsPaste, true);

  const done = tools.parseClaudeAuthChunk('Login successful. Press Enter to continue…');
  assert.equal(done.success, true);
  assert.equal(done.wantsEnter, true);

  const quiet = tools.parseClaudeAuthChunk('Welcome to Claude Code');
  assert.equal(quiet.url, null);
  assert.equal(quiet.wantsPaste, false);
  assert.equal(quiet.success, false);
});

test('parseClaudeAuthChunk sees through ANSI styling', () => {
  const s = '\x1b[1mSelect \x1b[36mlogin method\x1b[0m:\r\n\x1b[7m❯ Claude account\x1b[0m\r\nhttps://claude.ai/oauth/authorize?x=1';
  const r = tools.parseClaudeAuthChunk(s);
  assert.equal(r.wantsMethod, true);
  assert.equal(r.url, 'https://claude.ai/oauth/authorize?x=1');
});

test('parseGhAuthChunk sees through ANSI colors (real gh output)', () => {
  const real = '\r\n\x1b[0;33m!\x1b[0m First copy your one-time code: \x1b[0;1;39m6526-9879\x1b[0m\r\n'
    + '\x1b[0;1;39mPress Enter\x1b[0m to open https://github.com/login/device in your browser... ';
  const r = tools.parseGhAuthChunk(real);
  assert.equal(r.code, '6526-9879');
  assert.equal(r.url, 'https://github.com/login/device');
  assert.equal(r.wantsEnter, true);
});
