---
name: site-migration
description: Bring an existing live website (Webflow, Framer, Squarespace, Wix, WordPress or any URL) into Radial as an Astro or Next.js codebase the customer owns, preserving its design, content, URLs, integrations and editing workflow. Use whenever someone asks to migrate, import, pull in, copy, clone, rebuild or move off a site builder so they can edit the site in Radial.
---

# Site migration in Radial

The published site is the visual and behavioral reference. CMS exports are content evidence. The person's requests define the scope. A migration is not an implicit redesign: preserve what is there, and record every intentional difference.

Radial gives you tools a plain chat does not have. Use them: `radial migrate capture` records the live site, `radial migrate compare` shows you where the rebuild differs from it, and Radial runs the project's dev server and preview for you.

## Starting points

- **From Radial Home (no project open):** run `radial migrate start <url> --framework astro|next`. It scaffolds a new project, captures the live site, writes the intent record and starts the migration agent in that project. If the person did not say which framework, ask them (Astro or Next.js) before running it; never pick one for them. Add `--include <file>` for anything they share from their site: CMS exports, logos, fonts, brand guidelines, copy docs. Add `--only <path>` (repeatable) when they want part of the site first, such as `--only /` for just the homepage. Tell them Claude Code may ask to trust the new folder and that they should choose Yes, and recommend one of the latest frontier models at high to max effort for best results. Then report progress with `radial agent wait` / `radial agent output`.
- **Inside a project (new, blank or existing):** run `radial migrate capture <url>` here (`--only <path>` for part of the site), then follow the workflow below. Use the framework this project already uses; do not switch it.
- **You were started by `migrate start`:** the capture and `.context/migration.md` already exist. Begin at "Read the evidence".

## Establish the contract

Read `.context/migration.md`, the project's AGENTS.md and any existing work first. Settle, from what you have:

- Source site and capture (authoritative), and which design differences, if any, are authorized.
- Framework (given), and **who edits content after the move**. Ask this before modeling content. Two good answers:
  1. **In-repo content, edited in Radial** (default for small teams): collections become content files in the repository, and pages keep literal text, following [Radial editing conventions](references/radial-editing.md).
  2. **A hosted CMS** (Sanity, etc.) when nontechnical editors need their own studio: propose it and get agreement before creating any account, project or dataset.
- Hosting, staging and production: staging can be shared once verified; DNS cutover is a separate, explicit, later action.

Ask only what changes a consequential decision; otherwise proceed and record your assumption in `.context/migration.md`. Keep earlier authorization; do not re-ask for routine steps.

## Read the evidence

The capture folder (path in `.context/migration.md`) holds:

- `README.md`: summary and gaps. Read it first.
- `inventory.json`: every route with status, redirects, title, description, canonical, headings, links, scripts, forms and template; `templates`, `collections`, `integrations`, `forms`; `assets` maps each original URL to its downloaded file.
- `pages/`: raw HTML exactly as served. Copy markup from here.
- `assets/<host>/`: stylesheets, scripts, images, fonts, media and documents.
- `screens/<route>@<width>.png`: the visual reference at 390, 768 and 1440. Look at them.
- `provided/`: files the person shared. CMS exports are the source of truth for collections (drafts, hidden fields, references); logos, fonts and brand files are originals to prefer over captured copies; documents are context.

Never edit the capture. To refresh evidence, run `radial migrate capture` again (it writes a new capture).

Know what a capture cannot hold: pages behind logins, platform server features (forms, search, memberships, commerce), redirect rules kept only in platform settings, and traffic history. Name these gaps to the person instead of guessing.

## Rebuild

Read [platform notes](references/platforms.md) for the source platform, and [implementation patterns](references/implementation.md) for rendering, content modeling and hosting decisions.

1. **Clear the starter.** Remove the scaffold's demo pages, components and styles. Next.js starters include Tailwind; its preflight reset changes an original site's CSS, so remove Tailwind unless the source used it.
2. **Map routes.** Every captured 200 route gets a destination with the same path, trailing-slash behavior and casing. Captured 3xx routes become redirects (Astro `redirects` config, Next `redirects()`).
3. **Port shared structure.** One layout for the shared `<head>`, navigation and footer, with page metadata (title, description, canonical, Open Graph) per route from the inventory.
4. **Preserve markup and CSS.** Keep the original HTML hierarchy and class names, and the original stylesheets byte for byte. Copy assets into `public/`, keeping original file names where they are unique, and rewrite their URLs using `inventory.json → assets`. Keep the platform's interaction runtime when interactions depend on it (see platform notes). Avoid CSS cleanup, new fonts, new design systems and hydration wrappers.
5. **Collections.** Use the content decision. For in-repo content, write one Markdown file per item with double-quoted frontmatter strings, rendered by a template route; preserve slugs, dates (with time zone), ordering, draft and archived state, and references. Build from the CMS exports when present, and from the captured detail pages otherwise.
6. **Integrations and forms.** Keep analytics and third-party scripts with their original IDs. Forms lose their platform backend; ask the person how submissions should be handled and wire a tested replacement. Do not generate fake leads or analytics visits.

## Verify in layers

Read [verification and launch](references/verification-and-launch.md) before claiming parity or readiness.

- **Routes and content:** every captured route answers with the same status, title, description, canonical and headings; redirects answer 301 to the same targets; unknown URLs return 404.
- **Design:** run `radial migrate compare` (all reference templates, or `--route /path` for one). Open each `.diff.png` (changed pixels are magenta) and the live and local screenshots next to it. Fix real differences; record intentional ones in `.context/migration.md`. Never raise thresholds or mask a section to make a comparison pass. Use `radial shot` for a quick look at the preview.
- **Behavior:** mobile navigation, menus, sliders, tabs, video, pagination (every page, not just page two), forms, and links to documents.
- **Build:** a clean production build passes.

Describe readiness with these labels, and do not let one imply the next: implementation tested, visual parity checked, staging verified, production verified.

## Share, launch, hand off

- **Staging:** once the build passes, offer to publish to staging (`radial publish --to staging`) and do it only when the person agrees, since it makes the site reachable at a public address; check the URL while logged out. Production publishing and DNS changes need the person's explicit go-ahead too. Keep the old site running through cutover and early observation, and export the full DNS zone before changing it.
- **Hand-off:** update `.context/migration.md` with the status, intentional differences, open gaps (traffic history, form backend, accounts) and how content is edited now. Add an editor guide as `.context/editing.md` (`radial context add`) if editors will work in Radial.

## Working inside Radial

- Radial runs this project's dev server and preview. Read the URL with `radial url`; never start another server or assume a port. If the preview shows stale output, run `radial restart`.
- Before finishing, review [decision checks](references/decision-checks.md) for the situations that apply. The [case study](references/case-study.md) is a detailed retrospective of one completed migration. Read it for complex migrations; it is not a template for every site.
