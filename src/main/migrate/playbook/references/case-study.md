# Webflow migration: anonymized process audit

This audit reconstructs a completed implementation and staging workflow from its conversation history, code, checks and deployment evidence. It is a retrospective, not a verbatim transcript. Names, domains, account and project identifiers, people, business copy, local paths, DNS targets, tracker IDs, screenshots and identifying dates have been omitted. Exact project counts are generalized. Technical product names remain because they explain implementation choices.

The source was a multi-page marketing site with several CMS collections, article and profile templates, custom interactions, video, analytics and legacy redirects. The user required the existing visual design to remain unchanged, wanted a nontechnical CMS editing experience, and intended continued work through a visual development app and coding agents. The chosen implementation used Next.js and Sanity, with Cloudflare selected as the eventual production host and Vercel used for temporary staging. The reusable conclusions also apply to Astro and other frameworks; those alternative implementations were not built or tested in this case.

## 1. Scope, evidence and decision history

### Fidelity was the primary requirement

The request was to move off Webflow without a redesign. The published website, rather than an imagined component system, became the reference for DOM hierarchy, CSS, fonts, responsive behavior, SVGs, media and interactions. Editable source was retained separately from immutable captures. This avoided introducing layout changes through a new framework's default wrappers, resets or hydration.

The request grew to include a full mobile check, production readiness, SEO continuity, preservation of analytics and third-party scripts, a different production host, and easy editing of static page copy. These were treated as additions to the original fidelity requirement, not permission to replace it. DNS was explicitly left until last.

### Evidence was captured before extraction

The evidence set included raw HTML for every current sitemap URL, the sitemap itself, collection CSVs, a redirect export, an asset mapping, and the original browser behavior. The collections contained published, draft and archived records; some of those states overlapped. Asset mapping covered original CDN URLs and the later CMS image URLs.

A current sitemap was not treated as the entire historical URL universe. Internal links, exported records and legacy query-based pagination were also examined. Some legitimately published collection records were absent from the old sitemap and were included in the replacement. Search Console access was unavailable, so historical traffic-bearing URLs, backlink coverage and account verification remained an explicit limitation.

### Rendering choice served fidelity

The destination initially returned preserved HTML templates from server routes, with collection regions filled from the CMS. Shared navigation/footer and collection cards became reusable partials. This retained the exact markup relationships expected by the original CSS and browser runtime. The editorial Studio remained a normal React application.

This was a case-specific choice. An Astro implementation could use preserved templates, components, static generation, on-demand rendering or a hybrid. The important decision is how publication creates, updates and removes public routes while preserving the design. The original work did not establish that one framework is required for parity.

### CMS scope expanded beyond collections

The original import brought across collections, references, images, dates, slugs, feature flags, visibility and ordering. Later review established that the team's editing requirement also covered static page headings, paragraphs, buttons, links, navigation, footer, repeated labels, accessibility text and search metadata.

Fixed page/shared documents were added and grouped under human-readable pages and sections. A binding manifest connected each offered field to the exact text node or attribute in the preserved template. Each offered control was tested against rendered output. Controls that the application necessarily derived were removed from the editor rather than pretending those edits would work.

### Production hosting changed during the work

An earlier deployment established that the application worked on a conventional Next.js host. The user then selected Cloudflare for production, without account access yet. The project was adapted and tested locally in Cloudflare's runtime; the absence of account access was not represented as a completed remote deployment.

A subsequent request for a shareable staging site was handled with an isolated project on the already accessible hosting platform. Its CMS dataset was separate so reviewers could publish practice edits without changing content prepared for production. The stable staging URL was verified without a host login. No production DNS switch was part of this staging work.

## 2. Implementation and corrections

### Content import preserved relationships and intent

Imports used stable IDs and additive creation instead of overwriting records on every run. Original source evidence was retained. Draft records stayed drafts, archived records remained excluded, and publicly displayed team/news order used a deterministic tie-breaker where display-order values matched.

Imported images were mapped to original local bytes and responsive variants where equivalent. Newly uploaded assets used the CMS CDN. Removal behavior was tested because a convenient legacy URL fallback could otherwise resurrect an image an editor had deliberately removed. An intentionally blank article button label was preserved instead of being filled with a generic default.

### Original runtime code remained where useful

The original browser interaction runtime was hosted locally for menus and animations. Webflow CMS filtering and pagination dependencies were replaced with local behavior backed by server-rendered CMS content. Vendor assets were kept separate from deliberate migration fixes.

A later script audit found that broad CMS-plugin removal had also removed an unrelated social-sharing script. The extraction rule was narrowed and the sharing script restored. The lesson was to classify scripts by responsibility instead of removing everything from a familiar vendor.

### Pagination required both browser and HTTP checks

The listing initially displayed a limited number of server-rendered cards, with filtering and Load more controlled locally. Testing revealed that the no-JavaScript next-page link always pointed to the second page. The server was changed to advance the requested page, bound page numbers, and hide the control after the final page. Old Webflow query parameter names were retained where they had been valid entry points.

These bugs would not have been found by checking the initial card count or clicking Load more once. The reusable invariant is that the first state, intermediate states, reset, final state, no-JavaScript path and old bookmarked queries all need defined behavior.

### Mobile parity included an intentional defect fix

The original light navigation variant had invisible hamburger lines because their color was white. The migration used the surrounding logo/text color while retaining the same geometry. Additional menu checks covered open/close, Escape/Enter, link navigation, focus behavior and scroll locking/restoration.

This narrow change was recorded as intentional. It would have been misleading to claim every pixel was unchanged. It also would have been misleading to preserve an unusable menu silently under the banner of exact parity.

### Rich-text storage and editing were separated

Article and biography HTML included inline formatting and embedded content. The stored HTML was retained to avoid destructive conversion. A friendly text-passage input let editors change wording without exposing raw HTML; link destinations were accessible separately, and adding a paragraph was supported. This was a copy editor, not a complete formatting or embedded-media authoring environment.

The authenticated browser test exposed a subtle custom-input defect. Native CMS input props carried a whole-field value/change handler into a textarea intended to edit only one passage. In one version, editing a passage replaced the complete HTML field with plain text; in another, the inherited controlled value prevented the intended save. The input explicitly overrode those inherited behaviors. Clearing and retyping text next to bold content was tested, including saving on blur and preservation of links and media.

This was caught with disposable draft content and cleaned up. Schema validation and a login-screen screenshot alone would not have caught it.

### Cloudflare required real runtime testing

The server initially depended on reading template files from a conventional filesystem. Templates and image maps were bundled for the deployment runtime, while development continued reading editable source for hot reload. Client-only loading kept the large Studio package out of the server execution bundle and substantially reduced its size.

The adapter version used in this case omitted a new framework preview manifest from its manifest-inlining process. The result was a runtime failure across routes despite a successful build. A small, reproducible, version-specific patch included the actual generated manifest and failed if upstream code no longer matched the expected shape. Replacing security-related preview data with empty values was rejected as an unsafe shortcut.

The patch is not a recommendation for all future versions. A new migration must reproduce the defect and check current official documentation before carrying any workaround forward.

### The runtime harness itself had defects

Local runtime transport rewrote the Host header and rejected certain browser Origin headers before the request reached the application. This first made production-host indexing assertions fail and later prevented styles/scripts from loading. The harness was adjusted to reproduce real ingress semantics before calling the unchanged deployment artifact.

Another navigation assertion ran before an animated state transition completed. It was changed to wait for the relevant state, rather than declaring a false runtime defect. This distinction matters: correct the test transport or synchronization without weakening application host/origin checks.

### Staging became a separate editorial environment

The CMS provider's one-command clone was plan-gated. A supported export/import workflow copied content, assets and references into a new staging dataset without upgrading the plan or overwriting production. A separate hosting project was used for the shareable site. Both build-time and runtime dataset settings were configured, and the Studio title identified staging.

Dataset copies retained image IDs but changed their CDN URL namespace. Local asset mapping was adapted so equivalent staging images still used the original responsive bytes. Staging publication was tested with disposable records, while production remained untouched. Test scripts were parameterized so a staging check would not accidentally write to the default production dataset.

## 3. Verification performed and what it established

### Route and content evidence

Automated checks compared every captured route with the new renderer, including headings, article text, collection ordering, local assets, new CMS routes and visibility exclusions. Redirects were checked as real HTTP responses, including external destinations and campaign query parameters. Unknown URLs returned a real unindexed 404.

The sitemap preserved all originally listed pages and included additional intentionally published records. Public canonicals retained the chosen production domain. Static/shared copy fields were individually mutated in controlled rendering tests to prove that they changed the intended output. Text escaping and dangerous link protocols were also checked.

### Visual evidence

Representative home, company, listing, article and profile templates were compared at narrow mobile, common mobile, tablet and desktop widths. Full-page dimensions matched. Most desktop images matched at the chosen pixel-comparison threshold; a tiny residual difference was inspected and localized to font-edge rendering. Mobile differences included the deliberate hamburger correction.

Fonts and images were allowed to settle, lazy content was triggered, and only known time-varying canvas/video pixels were excluded from pixel comparison. Media playback, pause and sound were tested separately. Tests used browser engines and emulated viewports; they were not physical-device tests.

### Browser and CMS evidence

Browser checks covered routes, overflow, images, client errors, navigation, filters and pagination. A second browser engine exercised important page templates and mobile interactions. CMS tests created uniquely named temporary records, verified draft exclusion, publication, updates, archive/deletion and disappearance, then cleaned them up.

The authenticated Studio test navigated named page groups and changed draft text through the actual custom editor. It verified preservation of bold text, links and media. This provided stronger evidence than schema validation or the presence of a sign-in page.

### Search and integration evidence

The SEO audit compared current published source metadata, canonical URLs, visible content, internal targets and script inventories with production-host rendering. Preview hosts blocked indexing and suppressed analytics; public-host rendering allowed indexing. Original verification and structured-data presence was inspected rather than assuming such tags existed.

Runtime analytics checks confirmed the original loader initialized and generated metric requests on representative page types. Collection requests were intercepted to avoid synthetic traffic. This established trigger behavior, not receipt in the analytics dashboard. Dashboard receipt remained a live-domain/account check.

### Deployment evidence

Lint, types, migration invariants, CMS schema validation, framework build and deployment packaging passed. The actual local Cloudflare runtime served the published route set, assets, redirects, host-dependent indexing/analytics behavior, navigation, pagination and Studio sign-in.

Remote staging was separately built and checked on the temporary host. These results did not imply that a remote Cloudflare account, production CPU allocation, custom domains or public certificates had been tested. Environment identity was part of the evidence, not hidden behind a generic “deployed” label.

## 4. Remaining limits and readiness judgment

The implementation and staging could be verified while the production launch remained pending. Missing final-host account access prevented a remote production deployment check. Public-domain HTTPS, DNS propagation, host redirect policy, actual Googlebot access and analytics dashboard receipt still required the final cutover sequence.

Search Console history was unavailable. Current sitemap and internal-link parity did not prove complete historical traffic URL coverage, and no zero-traffic-loss guarantee was made. The final monitoring plan tracked landing-page clicks, impressions, indexing and missing-page errors after launch.

A dependency audit retained unresolved tooling advisories. Compatible fixes were applied, paths and exposure were assessed, and a forced incompatible downgrade was avoided. The report did not call the audit clean. Future use must reassess current versions and exposure rather than inheriting that assessment.

The runtime fallback could serve last-known data or an original migration snapshot during a CMS outage. Health distinguished live and degraded states and fallback responses avoided long CDN caching. A cold-start backup could still show old editorial content; that was documented rather than represented as seamless durable failover.

The editor did not include unpublished visual overlays. Public pages showed published content, and editors used the CMS's draft/publish controls. Existing embedded media and formatting were preserved, but more extensive media/layout changes remained source work. Team access required invitations to actual known accounts; recipient identities were not invented.

Production was therefore described in stages: implementation tested, target runtime prepared, remote staging verified, then production-domain verified only after cutover. The original hosting was to remain available through propagation and early observation, with the complete DNS zone and rollback web targets retained.

## 5. Reusable method and future improvements

### Repeat the invariants, not the technology choices

Preserve the user's design and public URL contract. Capture source evidence before editing. Import content without overwriting later work. Keep drafts and archives private. Preserve original integrations intentionally. Make every CMS control real. Test the built host runtime. Keep staging edits separate. Label evidence and remaining limits accurately. Treat DNS as its own authorized release action.

For Astro, choose static versus on-demand output based on editorial latency and route needs. A static version needs a tested CMS-to-build workflow and deletion/new-route behavior. A server version needs the correct adapter and runtime checks. Neither inherits success from the Next.js implementation.

### Improve the order of work

A repeat migration should inventory static copy and editor needs at the beginning, not after the collections import. It should choose the likely production host early, execute a small real-runtime proof before deep implementation, and create an isolated staging dataset before inviting editorial testing.

Script classification should precede removal. Pagination should be tested beyond its first transition. Rich-text editor behavior should be tested with real formatting and media before being called nontechnical-ready. Readiness reports should distinguish implementation, staging and public-domain checks from the outset.

### Keep reusable assets anonymous and scoped

The portable skill includes a framework/host decision guide, a verification and launch checklist, a raw HTTP snapshot/comparison helper, and scenario checks. It does not include client source, exported records, screenshots, account IDs, credentials, the original DNS recipe, or a hard-coded analytics property.

The full case audit preserves causes, corrections, evidence boundaries and unresolved limits. It does not prescribe an agency's authentication setup, a particular client's CMS schema, blanket permission bypass, a fixed pixel threshold, or a provider plan upgrade. Those decisions belong to the next project's actual requirements and evidence.
