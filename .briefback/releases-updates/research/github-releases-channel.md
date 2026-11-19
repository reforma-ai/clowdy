# GitHub Releases as the distribution channel

Sources fetched 2026-11-18 unless dated otherwise. electron-updater behavior was read from its installed source (`electron-updater` 6.8.11 in Reforma's `node_modules`, `out/providers/GitHubProvider.js`), which is more reliable than its docs.

## Summary

- **electron-updater's GitHub provider works without the REST API** for public repos: it reads `github.com/<o>/<r>/releases.atom` and `github.com/<o>/<r>/releases/latest` (web endpoints), then downloads `latest-mac.yml` / `latest.yml` and the payloads from `github.com/<o>/<r>/releases/download/<tag>/<file>`. So the 60 requests/hour unauthenticated API limit does not apply to shell updates.
- **The shell follows GitHub's single "Latest release" flag.** Any other release that becomes "Latest" (an OTA bundle, say) breaks shell updates with `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`. Separate streams in one repo need `make_latest: false` (or prerelease) on everything that is not a shell release.
- **A private repo cannot serve updates to normal users.** Assets of a private repo need a token on every user's machine (`GH_TOKEN` + `private: true` uses the API, 5,000/h per token); electron-builder's docs call it "very special cases". The usual answers are a public repo, or a separate public releases-only repo that the private repo's CI publishes into.
- **OTA bundles must be archives, not file trees.** A release holds at most 1,000 assets (each under 2 GiB, no total or bandwidth limit), and Clowdy's dev renderer is already 1,822 files. One archive per bundle plus a signed manifest replaces Reforma's per-file layout.
- **There is no mutable pointer object.** R2's `front/manifest.json` has no GitHub equivalent except `releases/latest/download/<asset>` (bound to the one "Latest" release) or a fixed-tag release whose asset is deleted and re-uploaded (not atomic; impossible once "immutable releases" is on).
- **Signing is unchanged by the channel:** macOS needs a Developer ID signature for Squirrel.Mac to update at all; Windows can update unsigned but should be signed (Azure Artifact Signing is the planned route in Reforma).
- **The account is GitHub Free with a private repo**, which limits CI: no environments, no rulesets or branch protection, $12 of included Actions compute per month with macOS at $0.062/min, 500 MB artifact storage.

## electron-updater GitHub provider, as implemented (6.8.11)

`GitHubProvider.getLatestVersion()`:

1. `GET https://github.com/<owner>/<repo>/releases.atom` (XML feed; observed to list the 10 newest releases).
2. Without `allowPrerelease`: `getLatestTagName()` requests `https://github.com/<owner>/<repo>/releases/latest` with `Accept: application/json` ("do not use API for GitHub to avoid limit"). Observed today on `oven-sh/bun`: a 302 (`cache-control: no-cache`) to `/releases/tag/<tag>`, whose JSON answer carries `tag_name`. This is an undocumented web endpoint, not the REST API.
3. With `allowPrerelease`: walks the atom feed; picks entries by semver prerelease tag (`alpha`, `beta`, custom channel names) relative to the running version's channel.
4. Downloads `<channel>.yml` (`latest-mac.yml` on macOS, `latest.yml` on Windows, `latest-linux.yml` on Linux) from `/releases/download/<tag>/`, and the files it names from the same release. Missing file → `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`.
5. Release notes come from the atom entry.

Consequences:

- "Latest" is GitHub's definition: "the most recent non-prerelease, non-draft release, sorted by the created_at attribute" (created_at is the date of the release's commit), overridable per release with `make_latest` (`true` default for newly published, `false`, `legacy`); drafts and prereleases cannot be latest (REST docs).
- Shell feeds must be assets of the release that is "Latest". OTA releases in the same repo must be published with `make_latest: false` or as prereleases. If shell releases themselves are prereleases (beta), stable clients do not see them.
- The tag is free-form for the stable path (`hrefRegExp = /\/tag\/(v?[^/]+)$/`); version comparison uses `version` inside the yml. Channel logic needs semver-shaped tags.
- Private repos: `PrivateGitHubProvider` is used when a token is configured and goes through `api.github.com` (5,000 requests/hour per token, up to 3 per check per the v26 docs).
- July 2025 incident (community discussion #166304): assets redirected to `release-assets.githubusercontent.com` (Azure Blob) returned 403 when an `Authorization` header was forwarded across the redirect; affected token-using clients; resolved by 22 July 2025 per the thread, not by an official statement. A lesson for OTA code: never forward auth headers across the redirect, and expect signed redirect URLs to expire during long downloads.

## electron-builder side

- Targets that update: macOS `zip` (required for Squirrel.Mac; dmg is for first install), Windows NSIS (`nsis` or `nsis-web`), Linux AppImage/deb/rpm/pacman. "macOS application must be signed in order for auto updating to work." (v26 auto-update docs.)
- `latest*.yml` are generated for every provider; with `provider: github` electron-builder can upload to a draft release itself (`--publish always`, `GH_TOKEN` with write access). Reforma instead builds with `--publish never` and uploads in a separate job; that pattern ports by swapping the R2 upload for `gh release create/upload` or the REST API.
- The GitHub provider config in the packaged `app-update.yml` names `owner` and `repo`. Those can point to a different repo than the source (for a public releases repo).
- No more feed path rewriting: with GitHub, the feed and files sit in the same release, so Reforma's `versionedFeed()` is unnecessary. Stable download links for the website become `https://github.com/<o>/<r>/releases/latest/download/<name>`, which requires an asset name without the version (electron-builder's default `artifactName` includes it; a version-less copy or a second name is needed). Inference.
- `stagingPercentage` in `latest*.yml` gives staged rollouts on any provider (edit the yml).
- `nsis-web`: the stub installer downloads its arch package from the release; with GitHub that URL is `/releases/download/<tag>/...`, which stays valid as long as the release exists (no pruning problem unless old releases are deleted). Inference.
- electron-builder v27 (unreleased "next" docs, 2026) makes `publisherName` mandatory when `app-update.yml` is written for signed Windows builds and adds signed update manifests; Clowdy is on 26.x.

## Using GitHub Releases for OTA bundles (renderer, daemon)

Facts:

- Limits: "Up to 1000 release assets may be associated with a single release." "Each file included in a release must be under 2 GiB." "There is no limit on the total size of a release, nor bandwidth usage." (About releases docs.)
- Stable URL forms: `/releases/latest` and `/releases/latest/download/<asset>` (Linking to releases docs). Both resolve against the single "Latest" release.
- Observed today: `github.com/.../releases/download/<tag>/<asset>` → 302 with `cache-control: no-cache` to a signed `release-assets.githubusercontent.com` URL. Pointer lookups therefore are not stale-cached at github.com.
- REST API: 60 requests/hour per IP unauthenticated, 5,000 per authenticated user, `GITHUB_TOKEN` 1,000/hour per repo. The docs do not say whether `github.com` download redirects count; electron-updater's design and wide practice say they do not, but they have undocumented abuse limits (community reports of 429s on `*.githubusercontent.com`).
- Immutable releases (GA 28 Oct 2025, repo or org setting): once a release is published its assets and tag cannot change; adding assets to a published release fails with 422.
- Draft releases are visible only to users with push access; published releases in a public repo are visible to everyone.

Ways to locate "the newest renderer/daemon bundle" without the REST API (options, not decisions):

| Option | How the client finds it | Trade-offs |
| --- | --- | --- |
| Fixed-tag pointer release (e.g. tag `ota`) holding `renderer.json` / `daemon.json`, payload archives in versioned releases with `make_latest: false` | `GET /releases/download/ota/renderer.json` | One extra request; replacing the asset is delete + upload (`gh release upload --clobber`), so a short 404 window; incompatible with immutable releases for that release |
| Attach OTA assets to the current "Latest" shell release | `GET /releases/latest/download/renderer.json` | No extra repo or tag; the publish job must copy the manifest into each new shell release; asset count grows (1,000 cap, prune); mixes streams |
| Read `releases.atom` and filter by tag prefix (`renderer-*`) | Feed of the newest 10 releases | No API; a burst of other releases can push the newest bundle out of the 10-entry window |
| Separate public repo per stream, each using "Latest" | `/releases/latest/download/...` per repo | Simplest lookup, more repos and tokens |
| GitHub Pages for manifests, Releases for payloads | `https://<user>.github.io/<repo>/renderer.json` | Pages on a private repo needs Pro; on a public releases repo it is free; Pages caches (~10 min) |
| REST API `GET /repos/.../releases` | JSON listing | 60/hour per IP shared behind NAT; avoid for hourly checks |

Whatever the lookup, Reforma's integrity model carries over unchanged: a manifest signed with a pinned Ed25519 key, listing the archive's SHA-256 and size (or every file's), so GitHub (or whoever controls the repo token) cannot push a payload the app accepts without the signing key.

## Private source repo

- Release assets of a private repo are not downloadable without credentials. Embedding a token in the app exposes it to every user; fine-grained PATs can be scoped to one repo read-only, but it still grants read access to the source if it is the same repo. (Inference from GitHub's permission model; electron-builder docs warn against the approach.)
- Common pattern: keep source private, create a public releases-only repo (e.g. `<owner>/clowdy-releases`), and let the private repo's workflow publish there with a fine-grained PAT or a GitHub App token limited to `contents: write` on that repo. electron-updater's `publish.owner/repo` then name the public repo. Release notes and tags become public; source does not.
- Alternatively make the source repo public, which also unlocks free Actions minutes, environments, rulesets and Pages on the Free plan.

## GitHub plan constraints (Free, private repo)

- Environments: "Users with GitHub Free plans can only configure environments for public repositories." Reforma's `desktop-release` environment pattern (secrets scoped to `main`) is unavailable; secrets would be repository secrets, which any branch's workflow can read. Pro, or a public repo, restores it. (Manage environments docs.)
- Rulesets and branch protection: 403 on this repo (observed). `GITFLOW.md`'s "Merge needs a green `ci-ok` check" cannot be enforced as a required check.
- Actions billing (docs page fetched today): Free includes **$12 USD** of compute per month for private repos, expressed in money not minutes. Per-minute: Linux 2-core $0.006, Windows 2-core $0.010, macOS $0.062. Public repos: standard hosted runners free. Storage: 500 MB artifacts (shared with Packages), 10 GB cache per repo. Rough inference: $12 ≈ 190 macOS minutes or 1,200 Windows minutes per month; a signed, notarized two-arch macOS build in Reforma's shape takes tens of minutes, and two-arch DMG+zip artifacts approach the 500 MB artifact quota unless `retention-days` is short or jobs upload straight to a draft release.
- The pricing page and the GitHub changelog (Dec 2025) disagree with some third-party posts about 2026 changes; the docs page is the source used here.

## Signing requirements (channel-independent)

**macOS**

- Certificate: Developer ID Application (direct distribution) from the Apple Developer Program (paid membership). CI gets it as `CSC_LINK` (base64 `.p12`) + `CSC_KEY_PASSWORD`; electron-builder imports it into a temporary keychain on CI.
- Notarization: App Store Connect API key (`.p8`, key id, issuer id) as `APPLE_API_KEY` (path), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (Reforma's working config); DMGs need a separate `notarytool submit --wait` + `stapler staple` after electron-builder (Reforma's workflow).
- Without signing, Squirrel.Mac refuses updates, so an ad-hoc build cannot auto-update; a later signed version must be installed by hand.
- Every extra Mach-O shipped (a `bun` binary for the daemon) is signed by electron-builder with `entitlementsInherit`. Bun's guide for compiled executables lists `allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables`, `disable-library-validation`; Reforma ships its compiled bun with `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` and it runs. Clowdy's inherit plist has only the first two.
- Universal vs two builds: Reforma builds `arm64` and `x64` separately in one electron-builder run on one macOS runner; one `latest-mac.yml` covers both.

**Windows**

- Unsigned NSIS updates work (electron-updater checks SHA-512 only); SmartScreen warns "unknown publisher".
- Azure Artifact Signing (formerly Trusted Signing): electron-builder config `endpoint`, `codeSigningAccountName`, `certificateProfileName`, `publisherName`; env `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; the app registration needs the "Trusted Signing Certificate Profile Signer" role; works on any build OS (Wine on macOS/Linux). Since 2024 EV certificates no longer bypass SmartScreen; EV and OV are treated the same.
- With signed builds, `verifyUpdateCodeSignature` + `publisherName` make electron-updater reject an update not signed by the same publisher (uses PowerShell `Get-AuthenticodeSignature`).
- Eligibility of individuals for Artifact Signing is restricted (a March 2026 Microsoft Q&A answer says individual validation is US/Canada only during preview); not verified against official docs.

## Alternatives briefly checked

- `update.electronjs.org` / `update-electron-app`: free, Squirrel-based, requires a **public** GitHub repo, releases on GitHub, signed macOS builds; Windows via Squirrel.Windows, not NSIS. Covers the shell only, no OTA.
- electron-updater `generic` provider pointed at GitHub URLs: possible for a fixed layout, but GitHub has no folder-style paths, so the github provider fits better.

## Sources

- electron-builder auto-update (v26): https://www.electron.build/v26/docs/features/auto-update (2026-11-18)
- electron-builder Windows code signing (v27 next): https://www.electron.build/docs/features/code-signing/code-signing-win (2026-11-18)
- electron-builder macOS code signing (v27 next): https://www.electron.build/docs/features/code-signing/code-signing-mac (2026-11-18)
- electron-updater 6.8.11 source: `node_modules/electron-updater/out/providers/GitHubProvider.js` in `/Users/bionic/WORK/Reforma/reforma` (2026-11-18)
- GitHub, About releases: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases (2026-11-18)
- GitHub, Linking to releases: https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases (2026-11-18)
- GitHub REST, Releases (`latest`, `make_latest`): https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28 (2026-11-18)
- GitHub REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28 (2026-11-18)
- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions (2026-11-18)
- GitHub Actions pricing changelog: https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/ (Dec 2025)
- GitHub environments: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments (2026-11-18)
- Immutable releases GA: https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/ (28 Oct 2025)
- Community discussion on electron-updater 403s: https://github.com/orgs/community/discussions/166304 (Jul 2025)
- Electron, Updating applications: https://www.electronjs.org/docs/latest/tutorial/updates (2026-11-18)
- Bun, Codesign a single-file executable on macOS: https://bun.com/docs/guides/runtime/codesign-macos-executable (2026-11-18)
- Azure Artifact Signing eligibility Q&A: https://learn.microsoft.com/en-us/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident (Mar 2026, AI-generated answer)
- Probes run today (read-only `curl` against `github.com/oven-sh/bun`): `/releases/latest` JSON redirect, asset redirect host, atom entry count.

## Open questions

- Do `github.com` asset redirects have a documented per-IP limit? Not found.
- Does replacing a pointer asset (delete + upload) produce a 404 window long enough to matter, and is the 302 ever cached by intermediaries? Not tested.
- Will the owner make the source public, add a public releases repo, or upgrade to Pro? Decides auth, environments, Pages, and cost.
- Apple Developer Program and Azure Artifact Signing accounts: do they exist or are they planned? Unsigned macOS builds cannot auto-update.

## Assumptions and limits

- electron-updater's behavior was read from 6.8.11; Clowdy would add whatever version resolves under `minimumReleaseAge` (Reforma uses `^6.8.11`).
- No release was created and no workflow run; GitHub's behavior beyond the read-only probes is from docs.
