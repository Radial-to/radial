# Implementation patterns

## Contents

Rendering choice; source preservation; content modeling; editor UX; host adaptation; staging isolation.

## Rendering is a product decision

| Approach | Fits | Publication requirement | Risks to verify |
| --- | --- | --- | --- |
| Preserved HTML templates returned by a server | Strict Webflow parity, existing interaction scripts, many dynamic CMS routes | Read published CMS data at request time with bounded cache | HTML sanitization, filesystem portability, content bindings, runtime CPU |
| Framework components with limited hydration | Team wants idiomatic components and continued development | Static rebuild or runtime query, chosen explicitly | Wrapper elements, whitespace, CSS specificity, lifecycle and duplicate initialization |
| Astro static output | Mostly marketing content, build latency is acceptable | Authenticated CMS webhook/build integration with retries and observable status | New/deleted routes, publication delay, stale assets, failed builds, preview access |
| Astro server/on-demand routes | Immediate publishing or dynamic endpoints | Server adapter compatible with the chosen host | Runtime limits, generated output, API/header/redirect behavior |
| Hybrid | Different route classes have different needs | Document the publication path for each class | Static pages silently lagging dynamic collection pages |

Astro is a destination option, not a conversion flag. Read the installed version's docs and the current official adapter documentation. Choose what is prerendered, how routes are generated, and how the CMS triggers publication. Raw template HTML can be an interim parity layer; do not assume a raw-HTML primitive executes or initializes all scripts identically. Verify the built output in a browser. In React-based frameworks, client-only Studio loading can avoid bundling the editor into server execution; this is a host/version-specific optimization to measure, not a universal rule.

## Capture and preserve source deliberately

Keep immutable evidence apart from `site/`, components, or other editable source. A useful manifest maps public route → original HTML → destination template → CMS record. Use stable, human-readable files for future maintainers. Extraction scripts should refuse already-migrated templates or require an explicit deliberate regeneration workflow.

Localize original assets with an origin-to-local manifest. Preserve content bytes and responsive `srcset`/`sizes`, image dimensions, loading behavior, fonts, SVGs and video containers. Asset matching may need content hashes: a CMS can deduplicate identical bytes from different filenames. A newer upload or changed asset ID must stop reusing an old image's responsive variants. A removed CMS image must not resurrect a hidden migration URL.

Retain original Webflow browser runtime assets if they provide interaction parity; removing Webflow hosting does not require rewriting every interaction immediately. Remove only identified CMS-dependent libraries whose behavior has been replaced. Broad package-name or script-tag deletion can remove unrelated social-sharing or custom behavior.

Keep source script inventory and runtime network inventory separate. Inline scripts may be deliberately externalized/localized, so byte/hash comparisons need a documented equivalence mapping, not a blanket exception. Do not silently remove original forms, search, memberships or ecommerce; exports often do not reproduce their hosted backend services. Inventory each dependency and arrange a tested replacement within scope.

## Model content for fidelity and editing

Import references in a deterministic pass with stable source IDs. Preserve source dates (including timezone), explicit display order and tie-breaking order. Sorting only by a display-order number can scramble records with equal values. Preserve slugs and redirects; inspect draft and archive columns separately, including their overlap.

Do not infer public visibility from the mere presence of a CSV row. A collection can contain entirely draft items that have no current public section. Do not invent that section simply because the data exists.

Add page/shared copy documents for static content, grouped by human section names. Distinguish button text from destination. Map every offered field to actual rendered output and test it independently. Hide/remove controls that the application necessarily derives, such as a pagination next-page URL. Give shared edits an obvious global scope. Singleton pages should not be duplicated or deleted through ordinary creation menus.

Prefer semantic stable field names in a new content model. For a mechanical parity migration, stable IDs plus a clear label/binding manifest can be useful; do not renumber IDs when inserting or deleting fields. Bind to text nodes/attributes without flattening nested spans, links, line breaks or icons. If positional text-node bindings are used, formatting/extraction must not silently shift the indexes. Escape text and restrict link protocols in rendering as well as validating editor inputs.

## Rich text needs its own migration test

Imported HTML can include figures, nested wrappers, attributes, inline marks, embedded media and intentional empty CTAs. Converting it through another rich-text model can lose information. Choose and document one of:

- A native rich-text model with complete conversion, preserved unsupported blocks, and round-trip fixtures.
- Preserved HTML storage with a friendly editor that changes text while retaining media/markup.
- A scoped interim HTML editor, explicitly described as technical editing rather than a finished nontechnical experience.

Never patch content merely because an editor mounted. Test no-op open/close, text replacement, deleting/retyping a segment next to formatting, links, media preservation, focus/keyboard access, drafts and publish. A plain-copy editor is not a complete formatting/media authoring tool; explain which operations still need a maintainer.

Custom Sanity input gotcha observed in the case study: spreading native `elementProps` into an inner textarea can carry the whole field's `value` and `onChange`. Override these deliberately if the textarea edits only one passage. Otherwise typing can replace the entire HTML field with plain text. A save-on-blur implementation must override both inherited value/change behavior, explain the save interaction, and verify clearing/retyping does not remove the focused control. Use granular text patches where appropriate and test concurrent-edit behavior before claiming it is supported.

Use the CMS's supported authenticated draft-preview mechanism if visual draft editing is required. Do not create an unauthenticated draft API, expose write credentials, or substitute empty preview/security manifests. A published-site iframe is not a draft preview.

## CMS reads, cache and failure behavior

Choose a bounded publication delay and test it through the deployed host, not only local development. Static output needs a build pipeline; runtime output needs cache expiry/revalidation. Explain whether a response cache actually runs on the chosen host: cache headers alone do not prove CDN behavior.

For a fallback policy, distinguish live data, stale last-known data and migration backup. Expose degraded health, log failures, and avoid long-cache propagation of fallback responses. A cold-start backup can regress later editorial changes; document this limitation and consider a durable last-known snapshot when requirements justify it.

## Adapt to the actual deployment runtime

Read current official host/adapter docs and installed framework docs. Local Node success does not prove an edge deployment works. Bundle required templates/asset manifests for runtimes without a conventional filesystem. Verify emitted assets, headers and redirects independently of application routing when the host serves assets directly.

Pin and document any necessary compatibility patch. Capture the specific failing version/API, reproduce the problem in the actual runtime, patch narrowly, fail if upstream shape changes, and identify when to remove it. Never copy a case-study patch into a newer adapter without confirming the defect still exists.

Measure server-bundle size, startup and CPU limits against current provider rules. Do not repeat historical compressed-size limits or assume an emulator measures billable production CPU. Avoid changing framework merely to satisfy an unverified old limit.

Separate test-harness defects from deployment defects. A local runtime transport may rewrite Host or reject browser Origin headers before a request reaches the app. Reproduce real ingress in the test harness without weakening deployed origin checks, and document that normalization in the evidence.

## Staging isolation

Use a separate CMS dataset/project when a review includes publishing practice. Copy content, asset binaries and references; verify document/asset counts and published visibility. A provider's cloud-clone feature may be plan-gated; supported export/import is a valid alternative without upgrading the plan. Do not overwrite an existing staging dataset that contains review work.

Configure both build-time public CMS identifiers and server runtime configuration consistently. Frameworks that inline public environment variables need a rebuild when the dataset changes. Persist configuration on the staging project, not only one deploy command, to prevent future deploys silently reverting to production. Make the editor title clearly say staging.

A dataset copy can preserve asset IDs while changing CDN URLs. Check local asset maps and responsive variants against the configured dataset. Rich HTML may still reference source-dataset asset URLs after import; those are read-only references, but verify they are intentional and not private dependencies. Keep canonical URLs on the intended public domain while suppressing indexing on staging.

Promote selected approved content deliberately; do not wholesale replace production with a staging dataset containing test records. Test a unique staging-only publish and confirm the production dataset/site remains unchanged.
