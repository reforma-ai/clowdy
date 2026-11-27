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

- [ ] Remove the frontend and daemon from the installer, preserve the local development flow and packaged runtime.
- [ ] Require a signed compatible bundle when no usable installed bundle exists, with progress and retry or quit. Preserve verified cached startup and rollback.
- [ ] Publish a compatible signed bootstrap before the shell; ensure old shells can fetch a compatible bundle and fail releases closed on missing keys.
- [ ] Set version 0.1.3 and update release guidance.
- Verify fresh install, retry, signature and compatibility rejection, existing offline startup, rollback, release ordering and packaged contents; run relevant shell checks and review before commit.

Partial progress: release-configured builds now require an Ed25519 public key. Checked missing-key rejection, local shell and signed OTA dry-run builds, shell tests (336), lint and typecheck. An independent review confirmed the guard only covers the public key: matching private keys and a published bootstrap still need verification.

Publication investigation: the existing OTA gate waits for a released shell; archive pruning can remove an archive named by a manifest already read by a client. A per-shell signed manifest and archive published in the same immutable release as the installer can provide a compatible fallback, but must be validated before the release becomes public. The latest OTA feed, retry UI, startup selection, packaging, rollback checks and concurrent publication remain to implement and verify.
