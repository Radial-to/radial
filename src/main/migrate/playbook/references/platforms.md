# Platform notes

What each site builder puts in its published pages, what breaks when you leave it, and how the person exports their CMS content. Check the capture's `inventory.json → platform` and the raw pages; builders change their output over time, so trust what you see over these notes.

## Webflow

- **Signals:** `data-wf-page` and `data-wf-site` on `<html>`, assets on `cdn.prod.website-files.com` (older: `assets.website-files.com`, `uploads-ssl.webflow.com`), `webflow.js`, jQuery from a CloudFront URL.
- **Interactions:** Webflow interactions (IX2) run from the site's `webflow.js` bundle and need jQuery, the `data-wf-page`/`data-wf-site` attributes on `<html>` and the small inline head script that adds the `w-mod-js` class. Keep all four for parity; replacing interactions is a separate, deliberate project.
- **Responsive images:** `srcset` variants named `-p-500`, `-p-800`, `-p-1080` and so on. Keep every variant and the `sizes` attribute.
- **CMS:** collection lists render as `w-dyn-list` / `w-dyn-items` / `w-dyn-item`; detail pages share one template (the same `data-wf-page`). Pagination uses `?<id>_page=N` query keys that may be bookmarked or indexed.
- **Server features that stay behind:** forms (`w-form` posts to Webflow), site search, memberships, ecommerce, password-protected pages, localization.
- **CMS export (person's steps):** Webflow Designer → CMS panel → select the collection → **Export** (CSV). Repeat per collection; files are named `<Site> - <Collection> - <id>.csv`. Redirects: Site settings → Publishing → 301 redirects (copy the list). Reference fields hold item IDs, and multi-image fields hold comma-separated URLs.

## Framer

- **Signals:** `framerusercontent.com`, `<meta name="generator" content="Framer …">`, `data-framer-*` attributes.
- **Output:** server-rendered HTML plus a React runtime from `framerusercontent.com/sites/…` that hydrates the page and drives appear effects, hovers, variants and smooth scroll. Breakpoint layouts often ship as separate DOM variants hidden by CSS classes; keep all of them.
- **Choose deliberately:** port the server-rendered markup and CSS and re-create interactions with CSS transitions or small scripts (owned, editable code), or keep Framer's runtime modules from the capture (closer to the original, but opaque generated code still loading Framer's runtime). Ask the person when the interactions matter; record the choice.
- **Images:** `framerusercontent.com/images/<hash>.<ext>` with `scale-down-to` query variants; each captured variant is a separate file.
- **Server features that stay behind:** forms, CMS search, localization, password pages.
- **CMS export (person's steps):** Framer → CMS → open the collection → **⋯** → **Export CSV** (availability depends on plan). Detail pages share a path prefix such as `/blog/<slug>`.

## Squarespace

- **Signals:** `static1.squarespace.com`, `images.squarespace-cdn.com`, `Static.SQUARESPACE_CONTEXT`.
- **Output:** server-rendered HTML with a large runtime that loads images lazily (`data-src`, `data-image` plus `?format=<width>w`), galleries, lightboxes and announcement bars. Captured pages may have `data-src` without `src`; the capture downloads the URLs it finds, so request a large `format` variant if you need more resolution.
- **Server features that stay behind:** forms, commerce, member areas, scheduling, comments.
- **Content export (person's steps):** Settings → Advanced → **Import / Export** → **Export** → WordPress. This gives an XML file with blog posts and basic pages; it leaves out most layout, product and gallery content. Products: Commerce → Inventory → **Export** (CSV).

## Wix

- **Signals:** `static.wixstatic.com`, `parastorage.com`.
- **Output:** heavily script-rendered with deeply nested, absolutely positioned layout. Expect to rebuild from the reference screenshots and captured content rather than port markup.
- **CMS export (person's steps):** Content Manager → open the collection → **More actions** → **Export to CSV**.

## WordPress

- **Signals:** `/wp-content/`, `/wp-includes/`.
- **Output:** theme-rendered HTML; plugins provide forms, search, SEO metadata and redirects.
- **Content export (person's steps):** Tools → **Export** → All content (WXR XML). Media lives under `/wp-content/uploads/`; the capture downloads the files pages use.

## Any other site

Treat the raw HTML and screenshots as the reference, inventory scripts by responsibility before removing any, and ask the person what is managed in an admin you cannot see.
