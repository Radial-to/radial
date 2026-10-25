# Radial editing conventions

How to lay out a migrated site so people can keep editing it in Radial's Content panel (and with `radial edit text` / `radial edit image`) without an agent. Follow these when the content decision is "in-repo content, edited in Radial".

## How Radial finds what to edit

- **Text:** Radial matches the visible text against the repository's source files (templates, Markdown, JSON). The edit applies in place only when that text appears exactly once across the source. Otherwise it goes to an agent.
- **Images:** a swap copies the new file into the site's asset folder and rewrites references to the old file name.
- **Pages pane:** lists static routes. Collection detail pages (`[slug]` routes) do not appear there yet; editors reach them through the preview.

## Conventions

- **One-off pages:** keep their copy as literal text in the page template (`.astro` or JSX), not in variables, arrays or data objects.
- **Collections (Astro):** one Markdown file per item in `src/content/<collection>/<slug>.md`, rendered by `src/pages/<route>/[slug].astro` with `getStaticPaths`. Define the collection with a schema in `src/content.config.ts`.
- **Collections (Next.js):** one Markdown file per item in `content/<collection>/<slug>.md`, read at build time by a small loader and rendered by `app/<route>/[slug]/page.tsx` with `generateStaticParams`.
- **Frontmatter:** double-quote every string value (typed colons and hashes stay safe), and keep dates in ISO 8601 with their time zone. Keep values distinct: do not repeat the title verbatim in the description or excerpt, or the edit becomes ambiguous.
- **Rich text:** prefer Markdown prose in the body. When parity needs the original HTML (figures, embeds, inline spans), keep it, and tell editors that formatted passages are edited by an agent or in code.
- **Images:** plain `<img>` tags pointing at files in `public/` with unique file names (for example `public/images/team-jane-doe.jpg`), keeping the original `srcset` and `sizes`. Do not route content images through `astro:assets`, `image()` schema fields or `next/image`; Radial cannot map their optimized URLs back to a file yet.
- **Data files:** Markdown frontmatter or JSON. YAML and TOML data files are not searched by Radial's editor.
- **Shared parts:** navigation and footer live in one component, so an edit there changes every page. Say so in the editor guide.
