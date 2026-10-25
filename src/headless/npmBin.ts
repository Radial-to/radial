/**
 * The radial-cli npm package's `radial` (plans/headless-core.md, phase 5):
 * the CLI on this machine's Node, always as the headless flavor. It never
 * looks for a Mac app: with nothing answering on its data dir it starts
 * `radial serve` in the background, and `radial serve` and `radial mcp` run
 * right here. Radial for Mac keeps the `radial` in its own bundle (this
 * repo's bin/radial), which drives the app.
 *
 * The package's bin/radial (written by scripts/pack-cli.mts) checks the Node
 * version and requires this file. bin/radial is also what the agent
 * terminals' `radial` shim runs (serve.ts nodePlatform's cliBin), and what
 * MCP clients are pointed at (RADIAL_CLI_SHIM: `radial mcp --install`,
 * `radial setup`).
 */
import fs from 'fs';
import path from 'path';

const bin = path.join(__dirname, '..', '..', 'bin', 'radial');
process.env.RADIAL_CLI_FLAVOR = 'headless';
for (const key of ['RADIAL_CLI_APP', 'RADIAL_CLI_APP_ARG', 'ELECTRON_RUN_AS_NODE']) delete process.env[key];
process.env.RADIAL_CLI_SHIM = (() => { try { return fs.realpathSync(bin); } catch { return bin; } })();
(require('../main/cli') as typeof import('../main/cli')).run(process.argv.slice(2));
