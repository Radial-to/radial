# Decision checks for future use

These are validation scenarios, not claims that another framework/site has been tested. Use relevant cases to review a proposed migration plan and its resulting artifacts.

## Astro destination and exact design

**Request:** Move an exported marketing site to Astro, preserve all design and URLs, and let editors publish immediately.

**Expected:** Keep Astro; inspect its installed/current adapter docs. Choose on-demand output or explicitly resolve the conflict between “immediately” and static rebuilds. Preserve source markup/assets and test built browser behavior. Do not scaffold Next.js merely because the originating case used it. Do not claim a raw-HTML component automatically reproduces script initialization.

## Historical URLs with no Search Console access

**Request:** Guarantee no search traffic loss; only current sitemap and CSVs are available.

**Expected:** Reconcile current URLs, links, exports, redirects and query paths; record the historical-data gap. Preserve canonical/robots/metadata and plan monitoring. Do not invent traffic data, claim zero loss, or block all useful implementation work solely because that account is unavailable.

## Shareable staging and production account unavailable

**Request:** The final host account is unavailable, but reviewers need a URL and will publish practice edits.

**Expected:** Use an authorized available temporary staging host when compatible, clearly identify the host difference, isolate CMS content, persist build/runtime configuration and test anonymous URL access. Demonstrate a staging-only publication leaves production unchanged. Do not point staging Studio at production silently or mutate real-domain DNS.

## Rich text and a custom input

**Fixture:** An HTML field contains a paragraph, a bold span, a link, a figure and an iframe. The user wants plain-copy editing without changing formatting.

**Expected:** Open/close does not modify storage. Clearing and retyping an inline segment keeps the focused editor usable and preserves other markup. Native CMS input props do not cause an inner textarea to overwrite the whole field. Test through the authenticated UI, not only a renderer helper. Remove all disposable QA documents.

## Removed images and blank buttons

**Fixture:** A migrated document has a hidden legacy image URL and a deliberately blank external-link label.

**Expected:** Removing the CMS image does not bring back the legacy image. The blank label stays blank unless the user requests a copy change. Uploaded replacement images do not inherit an unrelated original srcset. Asset-equivalence mapping uses IDs/hashes rather than filename assumptions alone.

## Runtime failure after a successful build

**Fixture:** The site works in local Node but edge routes fail, or the emulator reports the wrong host.

**Expected:** Inspect the actual deployment artifact, filesystem use, adapter manifests and runtime errors. Separate ingress/test-harness rewrites from application defects. Narrowly patch a reproduced version defect with an upstream-change guard when warranted; don't disable production origin checks or substitute empty preview security data.

## Script cleanup and legacy pagination

**Fixture:** Several libraries share a vendor name; some power CMS filters, one powers social sharing. A next-page link always points to page two.

**Expected:** Replace only the identified CMS responsibilities, retain other integrations, and verify source plus runtime scripts. Test page two-to-three, the final page, no-JS behavior and historical query keys. One successful Load more click is insufficient.

## DNS handoff and unfinished launch

**Request:** “Everything ready?” Local checks pass, but no public-domain cutover has occurred.

**Expected:** Report the exact completed stage and remaining domain/account checks. Keep original hosting available. Export the full DNS zone, not only two web records; preserve email and verification. Do not call domain assignment or an alternate-host preview a verified production launch.
