# Thin desktop shell

**Goal:** Install a thin shell that downloads a verified compatible app bundle on first launch.

**Decisions**

- Follow Reforma: use a verified installed bundle offline; when none exists, download with progress and offer retry or quit on failure.
- Publish a compatible signed bundle before exposing a new shell. Preserve a compatible bootstrap for older shells and do not publish a shell without its verification key.
- Keep Bun and ripgrep in the shell for now; they are native runtime tools, not the app bundle.
- Release as 0.1.3: 0.1.2 is already published.
- Windows release checks cover the shell and release scripts; renderer tests run separately.

## Stage 1 — Windows shell tests

- [x] Run shell and release-script tests on Windows without renderer tests and update release guidance.
- Checked: 25 files, 336 tests passed locally; root lint passed; reviewed separately. Commit: d2ab0429. Windows CI remains to be run.

## Stage 2 — Thin bootstrap and publishing

- [x] Remove the frontend and daemon from the installer, preserve the local development flow and packaged runtime.
- [x] Require a signed compatible bundle when no usable installed bundle exists, with progress and retry or quit. Preserve verified cached startup and rollback.
- [x] Publish a compatible signed bootstrap before the shell; ensure old shells can fetch a compatible bundle and fail releases closed on missing keys.
- [x] Set version 0.1.3 and update release guidance.

Partial progress: release-configured builds now require an Ed25519 public key. Checked missing-key rejection, local shell and signed OTA dry-run builds, shell tests (336), lint and typecheck. An independent review confirmed the guard only covers the public key: matching private keys and a published bootstrap still need verification.

Publication decision: the OTA gate waits for a released shell, so each shell release carries its own verified signed bootstrap. OTA archives are retained because clients may have read an older manifest.

Implemented per-shell signed fallback published with the installer, retained OTA archives, and selected the newest compatible signed manifest at first launch. Commits: 69ac2795 (release public-key guard), 26bb1203 (thin shell and bootstrap). Checks: shell suite 360 passed including signed local HTTP fixture, offline retry and cache, incompatible and tampered bundles, and rollback; lint, typecheck, frozen install, release-configured shell and signed bootstrap builds passed. macOS and Windows release artifacts built locally; feeds and archive contents checked, including Ubuntu p7zip integrity checks. Independent review found and verified fixes to bootstrap selection and artifact validation. Real installer execution, actual GitHub workflow concurrency and release publication remain for the parent to verify; publication was not attempted.

Follow-up: a shell upgrade with a valid cached bundle now checks both feeds in the background, preserving immediate offline startup and the normal restart offer. Coverage includes a newer bootstrap, a newer OTA, offline and inaccessible sources, invalid bootstrap manifests and archives, and an interrupted trial that rolls back without reinstalling a rejected bootstrap. Independent review verified the error handling and background download behavior. Shell suite: 371 tests passed; root lint and typecheck passed. Real installer execution remains for the parent to verify.
