# Verification and launch

## Build an evidence matrix

Record each check's target URL/build, dataset, time, browser/runtime and result. Distinguish observed evidence from planned checks. Store baseline captures and test results, not just a green summary.

| Area | Minimum useful proof | Easy false confidence |
| --- | --- | --- |
| Routes | Baseline/current sitemap plus internal/historical URLs reconciled; status codes and targets checked | Homepage loads |
| Content | Titles, rich text, references, ordering, blanks, draft/archive state and images match | Record counts match |
| Copy controls | Every offered field changes the corresponding output; default values preserve layout | Schema validates |
| Editor | Invited/authenticated session can save draft and publish; temporary QA content cleaned up | Login screen appears |
| Design | Full-page dimensions, typography, assets and inspected pixel diffs across templates/viewports | Screenshots have similar colors |
| Mobile | Open/close, link navigation, focus, keyboard, scroll lock/restoration and touch targets | Hamburger visible |
| Listings | Filter combinations, reset, load-more boundaries, final page and no-JS/legacy queries | First six cards match |
| Scripts | Source inventory plus runtime loading/trigger behavior; original IDs and consent behavior | Script URL exists |
| Hosting | Actual remote build/runtime, assets, headers, env, resource limits and unauthenticated access | Local build passes |
| Search | Same URLs/canonicals, expected 301/404, sitemap/robots, indexing and historical traffic coverage | SEO score is high |
| Launch | Real-domain HTTPS, apex policy, CMS publish, crawler access and analytics receipt | Domain assigned in dashboard |

## Design and interaction checks

Use representative templates, not only individual “important” pages. Include very narrow mobile, ordinary mobile, tablet, desktop and breakpoint boundaries. Check all routes for overflow/broken assets where practical; use a smaller template sample for expensive pixel comparisons.

Load the same fonts, wait for image decoding, trigger lazy content/scroll interactions, and settle animations before capture. Mask only identified time-varying canvas/video regions; keep their geometry visible to layout tests. Test their behavior separately. Do not exclude entire difficult sections to get a lower difference score.

Pixel thresholds are diagnostic, not a universal acceptance rule. Record changed pixels, dimensions and the reason for differences. A tiny font-edge variation is not proof of a layout defect; a tiny missing CTA may be important. Do not raise thresholds until tests pass without inspecting the differences. Emulated Chromium/WebKit is not a physical-device test.

Check menu contrast in each header variant and state. A working original defect may deserve an authorized narrow fix, but record the difference rather than calling it pixel-identical. Preserve intended geometry and class structure.

## SEO continuity

Keep existing URL paths, capitalization policy, trailing-slash behavior and canonical host unless a deliberate URL migration is requested. Preserve titles/descriptions/social assets and inspect improvements explicitly. Do not overwrite distinctive original metadata with a generic generated value.

Import the complete redirect export. Verify actual permanent responses, chains/loops, external destinations and campaign query preservation. A redirect object in source is not proof the host honors it. Preserve old Webflow pagination query keys where they produce meaningful landing pages. Decide and test pagination canonicals deliberately.

Reconcile the current sitemap with all public CMS records. Extra legitimately published pages may be intentional; missing indexed pages are more consequential. Missing content should return an appropriate 404/410, not a success page or blanket homepage redirect. Prevent development endpoints, editor paths and staging from being indexed. Confirm production guards do not accidentally ship `noindex`.

Search Console and backlink data address historical traffic-bearing URLs absent from current navigation/sitemaps. If unavailable, say exactly that; do not promise zero traffic loss. Retain domain verification DNS records or verification files. A hosting-only migration with unchanged URLs generally keeps the same Search Console property; check current Google guidance before submitting any migration-specific request.

After launch, compare clicks, impressions, indexing and 404s by landing page. Avoid claiming that technical parity guarantees ranking stability.

## Analytics and third-party services

Inventory script tags, inline behavior and runtime-injected requests. Retain existing tracker/property IDs, event names, consent triggers and production domain restrictions. Broad vendor removal can silently remove unrelated plugins.

For automated browser checks, intercept collection endpoints and confirm outgoing initialization/events without submitting synthetic visits. Do not log credential-bearing headers or complete visitor payloads. This proves request generation, not dashboard receipt. Receipt and real consent behavior need a production-domain/account check.

Test forms without generating real leads unless authorized; sandbox or intercept submissions where possible. Identify original Webflow backend dependencies separately from browser assets. Include search, downloads, media, cookies/consent, accessibility helpers and external apps in the dependency register.

## CMS validation without client-data damage

Use unique QA record IDs, conservative dates/visibility, and deterministic cleanup. Exercise draft exclusion → publish → edit → archive/delete → disappearance and confirm no temporary records remain. On staging, prove dataset isolation by comparing production before/after. Avoid hard-coded production IDs in reusable scripts.

Test cache delays within an explicit timeout; an arbitrary sleep alone does not verify publishing. Exercise image replacement/removal and newly created slugs, not only existing text. Avoid leaving test mutations live when a check fails: cleanup belongs in `finally`, with errors reported if cleanup itself fails.

Test editor access with a real authorized account. Do not print or persist its token in screenshots, traces, repositories or logs. A public website and authenticated Studio have different access boundaries.

## Deployment and staging

Use a separate staging project/target when that avoids altering the existing site's environment or custom domains. “Production” in a host's CLI may refer to the primary deployment of an isolated staging project; verify project ID and domain assignments before executing it. Conversely, a command called “preview” may be protected and unshareable outside the agency.

Verify the final stable URL without an existing login session. Check noindex/robots and analytics suppression, redirects, sitemap, assets, health and Studio. Register the exact origin with the CMS when required. Persist the intended dataset in both build/runtime environments. Keep the deployable source revision recorded; building locally is not shipping.

Remote staging on one host does not validate a different production runtime. State this directly when temporary staging and the final host differ. Repeat the platform-specific checks when the final account is available.

## Launch readiness and cutover

Use four distinct statuses:

- Implementation tested: code/schema/migration checks pass.
- Runtime prepared: actual local target runtime has passed integration tests.
- Remote staging verified: deployed shareable build, editor and publication path have been checked.
- Production verified: public domains, SSL, indexing, redirects, CMS and telemetry confirmed after cutover.

List remaining blockers and limitations with their practical impact. Do not use “production-ready in every way” when account/domain checks, traffic history or dependency risks remain unresolved. Report dependency advisories with actual dependency paths and exposed behavior; don't assume every development dependency is harmless or apply destructive forced downgrades merely for a zero count.

Export the full existing DNS zone and identify authoritative nameservers before changes. Preserve email, verification and unrelated service records. If moving DNS providers, verify imported records and DNSSEC/DS handling separately from the web-origin switch. Adding a Worker custom domain or invoking a deploy tool's domain command can be the actual DNS mutation.

Before cutover, reconcile source edits since the original capture. Establish a brief content freeze or a reviewed delta import using source modification times; resolve conflicts with newer destination edits instead of overwriting either side blindly.

At cutover verify certificates on apex and canonical host, permanent host redirect with path/query preservation, known redirects, public robots/canonicals, missing pages, critical interactions, editor login/publishing, CMS health and analytics dashboard receipt. Retain original hosting and a tested rollback path through initial observation. Preserve CMS edits if rolling back hosting.

## Handoff artifacts

Provide a short editor guide plus technical runbook/source map. Explain draft versus published content, whether visual drafts exist, how long publication takes, how to add redirects, and who owns layout/media changes. State which environment the share link and CMS point to. Include exact commands appropriate to the current framework/host, not a copied previous provider's DNS recipe.

If an app owns the development server, record how to read its assigned URL and request a restart through that app. Do not start or kill a second server based on an assumed port.
