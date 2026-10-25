## Live preview

Radial runs this project's dev server and hot-reloads the preview on every file edit.

- The server's current URL is in `.radial/dev.json` (its `url` field). The port is OS-assigned and changes on every restart — never assume a default port (3000, 4321, 5173) and never port-scan; read the file instead.
- If that file is missing or its URL doesn't answer, the preview isn't running — say so rather than starting a dev server yourself (a second server collides with Radial's shared preview).
- If an edit doesn't show up, hot reload may have wedged (the server answers but serves pre-edit output). Verify by fetching from the dev.json URL and comparing with disk; if they disagree, create an empty `.radial/restart-dev-server` file and Radial restarts the preview cleanly — then re-read `.radial/dev.json` for the new URL. Never kill or start dev-server processes yourself.

## Radial state files

Radial (the visual app) shares state with agents through files in `.radial/`:

- `.radial/comments.json` is review feedback pinned to pages. Each comment anchors to a `route` + CSS `selector` (or a context `file` + `quote`), with `text`, optional `images` (repo-relative paths you can read), and `resolved`. Only act on comments when the user asks you to (people batch feedback and send it when the set is ready; a comment sitting in the file is not a request yet). When asked: read the comments where `resolved` is false, make the fixes, then set `resolved` to true on exactly those comments, plus `resolvedBy` with your agent's name (for example "claude-code"). Edit fields in place and keep the file a valid JSON array; Radial picks up your edits within a second.
- `.radial/launch-check.json` is the latest pre-launch checklist report (SEO, accessibility, broken links). Read `results[].issues` for what to fix; `scannedAt` says how fresh it is. After fixing, create an empty `.radial/run-launch-check` file and Radial re-scans and rewrites the report (the project must be open in Radial with its preview running).

## Opening this project in Radial

From any terminal, `radial .` opens this folder in the Radial app (works whether or not the app is running; `open -a Radial .` does the same if the `radial` command isn't on PATH).
