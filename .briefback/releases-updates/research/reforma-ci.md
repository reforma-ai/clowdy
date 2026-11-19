# Reforma: release CI, publishing, signing

Read on 2026-11-18 from `/Users/bionic/WORK/Reforma/reforma` (main checkout, not run). Reforma's own design doc for this area is `.briefback/docs/desktop/releases.md`, with the one-time setup in `.briefback/docs/desktop/release-setup.md`; both are current and detailed, and this page summarizes them against the source.

## Summary

Reforma ships its desktop app through two channels that release on their own schedules, both to one Cloudflare R2 bucket behind a public HTTPS domain:

- **Shell**: the Electron app (main, preload, a bundled copy of the web front, a toolchain). Cut by raising `version` in `apps/desktop/package.json`; built, signed, and notarized in `.github/workflows/build_desktop.yml`; installed by electron-updater with the **generic** provider.
- **Front**: the web front rebuilt for `app://reforma`, published after every web deploy by the `desktop` job of `.github/workflows/build_front.yml`, signed with an Ed25519 key, installed by the app's own OTA code (`src/ota.ts`).

Reforma has **no OTA for a backend/runtime**: the toolchain (a compiled bun "controller" that local projects run on) ships only inside the shell. Clowdy's daemon OTA has no Reforma precedent.

## Shell release workflow (`build_desktop.yml`)

- **Trigger:** push to `main` touching `apps/desktop/package.json` or the workflow file, or `workflow_dispatch` on `main`. No tags, no changesets.
- **Concurrency:** group `desktop-release`, `cancel-in-progress: false` (a running release is never cancelled; a newer push replaces only a waiting run).
- **Jobs:**
  1. `check` (ubuntu): `bun apps/desktop/scripts/publish-shell.ts check` reads the bucket and outputs `decision`: `build` (unpublished and above `desktop/latest.json`), `promote` (published, pointers behind), `skip` (published and pointers current, or `0.0.0`), `fail` (unpublished and not above newest).
  2. `macos` (`macos-26`, Xcode 26 for the Icon Composer icon): full-history checkout (front version counts commits), Node 24 + Bun 1.4.0, `bun run build:app` (bakes API URL, release host, front public key), builds toolchains for both archs, writes the App Store Connect `.p8` from base64, checks that `CSC_LINK` opens as a `.p12` with `/usr/bin/openssl` (LibreSSL) and otherwise **warns and builds ad-hoc** (`-c.mac.identity=- -c.mac.hardenedRuntime=false -c.mac.notarize=false`), then `bun run release` (electron-builder `--mac --publish never`, generic publish URL, both archs in one run so one `latest-mac.yml` covers both). electron-builder notarizes the apps; the workflow then runs `xcrun notarytool submit <dmg> --key/--key-id/--issuer --wait` and `xcrun stapler staple` on each DMG. Verification step: `codesign --verify --deep --strict`, `spctl -a -t exec` (signed only), fuse read-back with `electron-fuses read`, `spctl -a -t open` and `stapler validate` on DMGs. Uploads DMG, zip, blockmap, `latest-mac.yml` as a workflow artifact.
  3. `linux` (ubuntu): deb + `latest-linux.yml`, no secrets.
  4. `windows` (`windows-latest`): runs desktop tests on Windows (CI is Linux-only otherwise), then `release:win` builds an `nsis-web` stub installer for both archs, the per-arch `.nsis.7z` packages and `latest.yml`. **Unsigned**, no secrets.
  5. `publish` (ubuntu): needs all build jobs (`!cancelled()` guard), downloads artifacts into `apps/desktop/release`, runs `publish-shell.ts publish`, writes stable download links to the job summary.
- **Secret scoping:** secrets live in the GitHub environment `desktop-release` (branch policy: `main` only) and are passed only to the steps that need them; `bun install` and the front build never see signing secrets.

## Front release (`build_front.yml`, job `desktop`)

- Runs after the Cloudflare Pages web deploy, on `main`, only when the repository variable `DESKTOP_RELEASES_ENABLED == 'true'` (a job-level `if` cannot read environment variables). Environment `desktop-release`. Full-history checkout.
- Builds `apps/front` with `build:desktop` (`VITE_API_URL=app://reforma/api vite build --mode desktop`), then `bun apps/desktop/scripts/publish-front.ts`.
- A skip is a `::notice`, a failure leaves the web deploy intact. Concurrency `front-deploy-main` **cancels** in progress; safe because the pointer is written last.

## Publishing scripts (`apps/desktop/scripts/`)

- `targets.ts` — `RELEASE_TARGETS`, the one list of OS/arch/installer/update payload/feed; read by `electron-builder.ts`, `toolchain.ts`, `publish-shell.ts`.
- `publish-shell.ts` — `decide()` (the four decisions), `publish()` (uploads every file to `desktop/<version>/` as immutable, writes `desktop/<version>/release.json` **last** as the "published" marker, then `movePointers()`), `versionedFeed()` (rewrites `url:`/`path:` lines of `latest*.yml` to `<version>/<file>` because the live feed sits at `desktop/` while files sit in the version folder), `installerLinks()` (stable `Reforma-<arch>.dmg`, `Reforma-x64.deb`, `Reforma-Setup.exe` copies). Pointer order: feeds, stable installers, `desktop/latest.json` last. Then prunes to the newest three published versions. Re-decides from the bucket on publish, so a stale rerun cannot rewrite a version or move a pointer back.
- `publish-front.ts` — `frontVersion()` = `git rev-list --first-parent --count HEAD` (integer, grows on `main`; a shell built from the same commit bundles the same number). Manifest `{ version, minShell, files: { path: { sha256, size } } }`, `minShell` = shell `version` in `package.json` at that commit. Publishes only if `desktop/latest.json` names a shell ≥ `minShell`, and only if `front/manifest.json` is older. Order: every file (32 uploads at once; ~1,900 files took 10 minutes one at a time), then `front/<version>/manifest.json`, then the pointer `front/manifest.json`. Prunes to three.
- `release-bucket.ts` — `Bucket` interface (`read`, `write`, `copy`, `list`, `delete`) and `r2Bucket()` on `@aws-sdk/client-s3`; `IMMUTABLE = 'public, max-age=31536000, immutable'`, `POINTER = 'no-cache'`; `pruneReleases()`. Reads go through the S3 API, never the cached public domain.
- `check-shell-version.ts` — run in `ci.yml` `pr-meta`: fails a PR that changes what the shell ships (`src/` non-test, `build/`, `electron-builder.ts`, `toolchain.ts`/`targets.ts`, `packages/types/src/desktop/`) without raising the shell version. This is what makes "shell version" a usable compatibility contract for fronts.
- `build.ts` — release build into `app/`: front desktop build, main/preload via `Bun.build` with `define` constants (`__REFORMA_API_URL__`, `__DESKTOP_RELEASES_URL__`, `__DESKTOP_FRONT_PUBLIC_KEY__`, Sentry DSNs), copies the front to `app/front`, writes an **unsigned** bundled manifest (version, `minShell`, hashes) inside the ASAR, writes the packaged `package.json` (`productName: Reforma`). Re-exports the public key so a private key set by mistake never ships; rejects non-Ed25519.

## Bucket layout (R2)

```text
desktop/latest-mac.yml | latest-linux.yml | latest.yml   live feeds (paths rewritten into <version>/)
desktop/Reforma-arm64.dmg | Reforma-x64.dmg | Reforma-x64.deb | Reforma-Setup.exe   stable links (copies)
desktop/latest.json                                       copy of newest release.json; the front's gate
desktop/<version>/...                                     all platform files, feeds as written, release.json { version, commit }
front/manifest.json                                       signed pointer the app checks
front/<version>/<files...> + manifest.json                one front, file by file
```

## Signing and hardening (`electron-builder.ts`, `build/`)

- Identity: `appId: ai.reforma.desktop`, `productName: Reforma`; dev runs use `productName: Reforma Dev` from `package.json`, the packaged `package.json` overrides it.
- macOS: targets `dmg` + `zip` for `arm64` and `x64`; `hardenedRuntime: true`; `entitlements.mac.plist` (allow-jit, allow-unsigned-executable-memory) for the app, `entitlements.mac.inherit.plist` (adds `disable-library-validation`) for every other Mach-O including the toolchain; `notarize: true` with `APPLE_API_KEY` (path to `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; `dmg.writeUpdateInfo: false` (stapling changes DMG hashes, so the feed lists only zips).
- Fuses flipped before signing: `runAsNode`, `enableNodeOptionsEnvironmentVariable`, `enableNodeCliInspectArguments`, `grantFileProtocolExtraPrivileges` off; `enableCookieEncryption`, `enableEmbeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar` on. (Clowdy already copies this block.)
- Windows: `nsis-web` target, `nsis.oneClick`, `perMachine: false` (per-user, no admin), `nsisWeb.publish` URL into the version folder. Unsigned; Azure Artifact Signing is a planned follow-up (`azureSignOptions` not yet in config).
- `publish` blocks for win/linux are generic and only present when `DESKTOP_RELEASES_URL` is set, so `app-update.yml` is written only by release builds; a `package` build never self-updates.

## Secrets and variables (`desktop-release` environment)

| Name | Kind | Purpose | R2-specific? |
| --- | --- | --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | secret | Developer ID Application `.p12` (base64) and password | no |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | secret | App Store Connect API key (base64 `.p8`) for notarytool | no |
| `DESKTOP_FRONT_SIGNING_KEY` | secret | Ed25519 PKCS#8 PEM that signs front manifests | no |
| `DESKTOP_FRONT_PUBLIC_KEY` | variable | its SPKI PEM, baked into every shell | no |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secret | bucket write | **yes** |
| `DESKTOP_RELEASES_BUCKET`, `DESKTOP_RELEASES_URL` | variable | bucket name, public origin baked into the app | **yes** (URL concept survives as "release host") |
| `DESKTOP_RELEASES_ENABLED` | repo variable | turns the front job on | no |

## What is R2-specific vs channel-agnostic

**R2-specific (must be replaced for GitHub Releases):** `release-bucket.ts` (S3 client, `Cache-Control` per object, server-side `copy` for stable links, `list` + `delete` prune), the folder layout with mutable pointer objects, per-file front upload (thousands of objects), reading state through the S3 API, `versionedFeed()` path rewriting (needed only because feeds and files live in different folders), the generic electron-updater provider URL `<host>/desktop`.

**Channel-agnostic (reusable as is or nearly):** the version scheme (semver shell in `package.json`, integer front version from commit count), `minShell` gating on both publish and install, `check-shell-version.ts`, the decision table idea (build/skip/promote/fail) and "marker last, pointer last, only forward" invariants, Ed25519 manifest signing (`src/front-manifest.ts`), the app-side OTA (`src/ota.ts`) apart from its URL shape, the macOS signing/notarization/verification steps, the job split (per-OS build jobs never publish; one publish job), secret scoping per step and per environment.

## Relevant files

- `.github/workflows/build_desktop.yml` — shell release.
- `.github/workflows/build_front.yml` — web deploy + desktop front publish.
- `.github/workflows/ci.yml` — PR gate: `plan` (`.github/scripts/ci-plan.ts`, Turbo `--affected` matrix), `check`, `pr-meta` (case-clash check, Biome, changesets, `check-shell-version.ts`), `security`, `ci-ok` aggregate.
- `.github/workflows/AGENTS.md` — conventions (Bun 1.4.0, Node 24, Turbo/Bun caches, environment-scoped secrets, deploy key for bot pushes).
- `apps/desktop/AGENTS.md` (Releases, Front updates) — rules and the secrets table.
- `apps/desktop/scripts/{targets,build,publish-shell,publish-front,release-bucket,check-shell-version}.ts` — as above.
- `apps/desktop/electron-builder.ts`, `apps/desktop/build/entitlements.mac{,.inherit}.plist`.

## Constraints and gotchas recorded by Reforma

- A shell version is `major.minor.patch` only: a prerelease suffix makes electron-builder write a channel feed (`beta-mac.yml`) instead of `latest-mac.yml`, and cannot be ordered by the scripts.
- A published version is never rewritten; a bad release is replaced by a higher version (no rollback, no unpublish).
- Unsigned/ad-hoc macOS builds publish anyway but **Squirrel.Mac never updates them**; users install the first signed version by hand.
- macOS updates only work from `/Applications`; the app offers to move itself.
- `nsis-web` installers saved by users break once their version is pruned (package downloaded from the version folder).
- electron-builder names Windows packages after the npm package name (`reforma-desktop-<version>-<arch>.nsis.7z`) regardless of `artifactName`.
- Windows runners have hung on downloads; every download in `toolchain.ts` has a timeout.

## Assumptions and limits

- Workflows and scripts were read, not run. Behavior claims about real runs come from Reforma's own `releases.md` "Not yet verified" section (first release 13 Nov 2026, ad-hoc signed; signed releases still pending an Apple account).
- `ci-plan.ts` and `toolchain.ts` were skimmed only for the parts above.
