# Releases and updates: research map

Research date: 2026-11-18. Clowdy at `b1560d0`; Reforma at its current `main` checkout.

## Question and scope

Clowdy needs (1) GitHub Actions CI that builds desktop release artifacts (macOS, Windows) and the renderer bundle, and (2) an update system: Electron shell auto-update plus OTA updates of the renderer and the daemon without reinstalling the shell. The owner wants it roughly like Reforma, which publishes to Cloudflare R2, but with GitHub Releases as the channel. Scope: how Reforma does it, what Clowdy has, and what changes on GitHub Releases. No plan or implementation.

## Summary

Reforma ships two channels to one R2 bucket: a signed, notarized **shell** (electron-updater, generic feed, semver in `apps/desktop/package.json`, cut by raising the version on `main`) and an Ed25519-signed **front** OTA (custom `src/ota.ts`: offline start from disk, atomic pointer swap, per-file SHA-256, 30 s `ready()` trial with rollback, `minShell` gate). The integrity and compatibility model is channel-agnostic. The R2 parts are the S3 client, mutable pointer objects, per-file uploads, and feed path rewriting. Reforma has no OTA for any runtime: its compiled-bun toolchain ships inside the shell.

Clowdy has no CI, no installers, no signing, no updater, and **no daemon in a packaged build** (`ensureDaemon` needs `CLOWDY_BUN` and `CLOWDY_DAEMON_ENTRY`, which only `./clowdy dev` sets). The renderer is served from one folder via `app://clowdy`, the same shape Reforma OTA plugs into. The daemon is a detached Bun process that outlives the app, gated by an exact `PROTOCOL_VERSION`, with forward-only SQLite migrations. A dev-only keeper already swaps an idle daemon and moves windows to it without a reload. Daemon OTA is the genuinely new design problem.

On GitHub Releases, electron-updater's GitHub provider avoids the REST API (it uses `releases.atom` and `/releases/latest`), but it follows the single "Latest" release, so OTA releases in the same repo must not become Latest. OTA payloads must be archives (1,000 assets per release; the dev renderer is 1,822 files). There is no mutable pointer object, so the manifest lookup needs a convention. Two account facts shape everything: the repo is **private on GitHub Free** (assets need a token, environments and branch protection are unavailable, $12/month of Actions compute with macOS at $0.062/min), and macOS auto-update **requires a Developer ID signature**.

## Topic pages

- [reforma-ci.md](reforma-ci.md): Reforma workflows (`build_desktop.yml`, `build_front.yml`, `ci.yml`), publish scripts, bucket layout, signing and notarization, secrets, and which parts are R2-specific or channel-agnostic.
- [reforma-updates.md](reforma-updates.md): Reforma runtime mechanics: shell updater (`updater.ts`) and front OTA (`ota.ts`, `front-manifest.ts`, protocol hash checks, trial and rollback, UI, dev behavior).
- [clowdy-current.md](clowdy-current.md): Clowdy build and packaging, renderer loading, daemon startup and keeper, versions and contracts, CI state, GitHub account facts.
- [github-releases-channel.md](github-releases-channel.md): electron-updater's GitHub provider as implemented, "Latest" semantics, OTA lookup options, private-repo problem, rate limits, plan limits, macOS and Windows signing requirements, sources.
- [clowdy-ota-constraints.md](clowdy-ota-constraints.md): how renderer OTA maps from Reforma, what daemon OTA must handle (process model, runtime shape, migrations, rollback), and the compatibility designs to choose between.

## Important files

Reforma (`/Users/bionic/WORK/Reforma/reforma`):
- `.github/workflows/build_desktop.yml`, `build_front.yml`, `ci.yml`, `AGENTS.md`
- `apps/desktop/scripts/{targets,build,publish-shell,publish-front,release-bucket,check-shell-version}.ts`
- `apps/desktop/src/{updater,ota,front-manifest,protocol,config,main}.ts`
- `apps/desktop/electron-builder.ts`, `build/entitlements.mac{,.inherit}.plist`
- `.briefback/docs/desktop/releases.md`, `release-setup.md` (Reforma's own design and setup docs)

Clowdy:
- `scripts/cli.ts`; `apps/desktop/scripts/{build,main-bundle,dev}.ts`; `apps/desktop/electron-builder.ts`
- `apps/desktop/src/main/{index,protocol,daemon,daemonHost,daemonKeeper,security,menu}.ts`; `src/shared/bridge.ts`
- `apps/daemon/src/{main,daemon,config}.ts`, `db/connection.ts`, `skills/materialize.ts`, `engine/acp/{bridge,registry,catalog}.ts`
- `packages/protocol/src/api.ts` (`PROTOCOL_VERSION`, `Health`, `DaemonInfo`), `paths.ts`
- `.briefback/mvp/research/daemon-runtime.md` (Bun vs compile, entitlements, process model)

## Open questions research could not answer

1. **Audience and repo visibility.** Will releases reach anyone besides the owner? (Shipping with subscription login needs Anthropic's approval per `.briefback/acp/research/policy.md`.) This decides: make the source public, add a public releases-only repo, upgrade to Pro, or accept a token-in-app setup for personal use.
2. **Signing accounts.** Is there an Apple Developer Program membership (needed for any macOS auto-update) and a Windows signing route (Azure Artifact Signing, whose individual eligibility looked restricted)?
3. **Identity.** `appId app.clowdy.desktop` and the `Clowdy` folder names follow a working name; AGENTS.md says to settle them before the first release.
4. **Daemon payload shape.** Bun shipped in the shell plus daemon JS (small OTA, no downloaded executables), or a compiled binary? Downloading executables on macOS was not tested.
5. **Daemon swap policy.** Only when `activeRuns === 0`, or with consent to interrupt? Should the shell auto-replace an older daemon after a shell update (today it refuses)?
6. **Compatibility model.** One OTA bundle (renderer + daemon) vs separate streams vs renderer-only OTA; exact protocol integer vs a range; daemon rollback given forward-only migrations.
7. **OTA lookup on GitHub.** Fixed-tag pointer release, assets on the Latest shell release, atom-feed filtering, Pages, or a repo per stream. Behavior of delete + re-upload windows and immutable releases was not tested.
8. **Platforms and archs.** macOS arm64 only or also x64; Windows x64/arm64; `nsis` vs `nsis-web`. Windows has never been run.
9. **CI gating.** The design-system package reportedly has failing tests and lint; a required gate cannot be enforced on this plan anyway. Which checks run, and is `ci-ok` aspirational?
10. **Cost.** Whether $12/month of included compute covers macOS release builds at the expected cadence was not measured.

## Assumptions and coverage limits

- Nothing was built, packaged, tested, or released; no GitHub resources were created. Network probes were read-only `curl` calls against a public repo (`oven-sh/bun`) and read-only `gh api` calls on `reforma-ai/clowdy`.
- Reforma's real-run claims come from its own docs (first ad-hoc release 13 Nov 2026; signed releases not yet run).
- electron-updater behavior is from the 6.8.11 source in Reforma's `node_modules`; electron-builder docs read were v26 (stable) and v27 (unreleased "next").
- Not read in depth: Reforma `toolchain.ts`, `ci-plan.ts`, `security.yml`, front-side update UI beyond file names; Clowdy `apps/daemon/AGENTS.md` beyond the run, environment, layout, invariants, and agents sections; `.briefback/acp/` research.
- `spec.md` is absent from the tree, so the product spec was not consulted.
- The current production renderer's file count was not measured (only a stale 17 Nov build and the dev build).
- The account plan (Free) is inferred from 403 messages, not from a plan field.
