# Local project data and shortcut hints

These settings live in **Settings → General**, on this machine. They are not account or repository preferences.

## Project data

“Keep Radial data local” is opt-in; installing an update preserves the existing project-folder storage behavior. Saved preferences remain in effect. Project settings offer Machine default, Local only, or In project folder. Preferences and project identities live under Electron userData in `project-data/preferences.json`. Canonical project paths resolve to stable data-folder IDs. Moving a project through Radial retains its ID.

Local mode routes Radial config, comments, attachments, notes, private rules, preview coordination files, and history indexes to the app data folder. Git recovery objects and refs remain in the local Git database. Radial does not add instructions or ignore rules to the working tree. Shared `AGENTS.md` is still read by agents; Radial's private rules are stored separately. Plain native CLI sessions can access private context through `radial context`.

Existing metadata is copied into local storage without deleting repository originals. Legacy `.radial/context` notes are imported too. A conflicting destination or symlink stops migration; originals are retained. This preference does not erase committed files or Git history. Moving between modes copies available files and preserves source copies; it does not mirror deletions. Private rules that conflict with an existing shared `AGENTS.md` must be reconciled before switching back to project storage.

Changes apply when the project reopens with its terminals closed, so live agents keep valid paths. The settings show when a switch is pending and can reveal the active data folder.

## Shortcut hints

A manual click on a supported canvas tool or app control, a mouse selection in the command palette, or a supported native menu action can show a small bottom-right reminder. No polling, network request, terminal interception, or focus transfer is involved.

Native-menu hints read the menu item's accelerator. App controls and palette entries use a snapshot of the installed menu, refreshed whenever Radial rebuilds it. Canvas hints and the host keyboard handler share `RadialToolKeys`. Radial currently has no shortcut customization UI; this change does not inspect OS-level remapping utilities.

Hints last ten seconds, pause while hovered/focused, and dismiss on Escape or window blur. Trying a shortcut or typing does not dismiss the reminder. They appear at most every thirty seconds and at most three times per action/binding on this machine. Existing error/status toasts and update notices take priority. “Turn off hints” in the card and “Show shortcut hints” in General settings control the same persisted preference. Hints only cover explicitly mapped controls; unrelated clicks are ignored.

## Verification

- `node --test test/projectData.test.js test/devGuard.test.js test/engine.test.js`
- `node --test test/projectStorage.e2e.mjs test/shortcutPromoter.e2e.mjs`

Electron tests use temporary projects and userData, then close their app instances and remove fixtures.
