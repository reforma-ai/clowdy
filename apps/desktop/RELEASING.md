# Setting up releases

What the repository owner sets up once so that GitHub builds Clowdy's installers, publishes OTA bundles, and installed apps update themselves. How the pipeline works is in [AGENTS.md → Releases](AGENTS.md#releases); this page only covers what to configure, where, and in which order.

Everything here lives in the repository settings on GitHub (`reforma-ai/clowdy` → **Settings**). Nothing goes into `.env` files or the code.

| Name | Kind | Needed for | When |
| --- | --- | --- | --- |
| `CLOWDY_OTA_SIGNING_KEY` | Environment secret | Signing OTA bundles | Before the first shell release |
| `CLOWDY_OTA_PUBLIC_KEY` | Repository variable | Baked into every shell, which checks bundles with it | Before the first shell release |
| `CSC_LINK` | Environment secret | Signing the macOS app | Once the Apple account is verified |
| `CSC_KEY_PASSWORD` | Environment secret | Opening `CSC_LINK` | Same |
| `APPLE_API_KEY` | Environment secret | Notarizing the macOS app | Same |
| `APPLE_API_KEY_ID` | Environment secret | Same | Same |
| `APPLE_API_ISSUER` | Environment secret | Same | Same |
| `APPLE_TEAM_ID` | Repository variable | Checking that the certificate and the signed app belong to your team | Same |

## The environment

The secrets are not repository secrets, which every branch and every pull request run can read. They live in the environment `desktop-release` (**Settings → Environments → New environment**), whose **Deployment branches and tags** is set to **Selected branches and tags** with the rules `main` and `next`. Only a job that declares `environment: desktop-release` reads them; GitHub refuses that job on any other branch. Add them under the environment's **Environment secrets → Add environment secret**.

The variables are not secret and stay repository variables: **Settings → Secrets and variables → Actions → Variables → New repository variable**. The workflows' own GitHub token needs nothing: they ask for write access themselves where they publish.

A secret can only be written, never read back, and `gh secret set` replaces one that exists. A placeholder you set earlier is overwritten by setting the name again; the list (`gh secret list --repo reforma-ai/clowdy --env desktop-release`) shows only names and dates, so it cannot tell a placeholder from a real value. The workflow can: see step 6.

## 1. Create the OTA key

Do this before the first shell release. A shell carries the public key it was built with. Release builds require it, and publication requires a matching private key.

In any folder outside the repository:

```sh
bun -e "const { generateKeyPairSync } = require('node:crypto'); const { writeFileSync } = require('node:fs'); const k = generateKeyPairSync('ed25519'); writeFileSync('ota-private.pem', k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); writeFileSync('ota-public.pem', k.publicKey.export({ type: 'spki', format: 'pem' }));"
```

Put the files into GitHub, either with `gh`:

```sh
gh secret set CLOWDY_OTA_SIGNING_KEY --repo reforma-ai/clowdy --env desktop-release < ota-private.pem
gh variable set CLOWDY_OTA_PUBLIC_KEY --repo reforma-ai/clowdy < ota-public.pem
```

or by hand: paste the whole of `ota-private.pem`, `BEGIN` and `END` lines included, as the environment secret `CLOWDY_OTA_SIGNING_KEY`, and `ota-public.pem` as the repository variable `CLOWDY_OTA_PUBLIC_KEY`.

Then move `ota-private.pem` into your password manager and delete the file. The key never changes casually: shells trust only the key they were built with, so a lost or replaced key means no OTA bundles until a shell built with the new key is out.

## 2. Check that Actions may run

**Settings → Actions → General → Actions permissions** must allow the workflows. The default, "Allow all actions and reusable workflows", works. If you restrict it to selected actions, allow the GitHub-owned ones and `oven-sh/setup-bun@*`.

## 3. Cut a shell release

A release is cut from `main`, which work reaches through the pull request from `next` ([GITFLOW.md → Pull Requests](../../GITFLOW.md#pull-requests)). The repository's ruleset **Protect main** (**Settings → Rules → Rulesets**) must let that merge through: it may require a pull request, but with **Restrict updates** on and nobody on its bypass list every merge stops at "Cannot update this protected ref", whatever the checks say.

Raise `version` in `apps/desktop/package.json` above the newest release (`major.minor.patch` only, for example `0.1.1` to `0.2.0`) in that pull request and merge it. Or open **Actions → Release shell → Run workflow** on `main`, which releases the current version if no release has it yet. A push that keeps the version releases nothing, so to re-run a release that failed, use the manual run.

The run takes about half an hour: `decide`, then `macos`, `windows` and `windows-test` side by side, then `publish`. The `windows-test` job runs the shell and release-script tests on Windows beside the packaging; the release does not run renderer tests. `publish` runs only when both builds and the Windows tests succeed. It signs and verifies a compatible bootstrap bundle and adds it to the draft release before making the installers public. A failed run leaves the version unreleased, so fix it and run it again. Each published `v<version>` release must keep its `manifest.json` and named bundle archive: that pair is the fallback for fresh installations of that shell.

The installer contains the native shell, Bun and ripgrep. On first launch it downloads the newest signed compatible bundle available from the OTA feed or the bundle attached to its shell release. It needs a network connection for that first download; a verified installed bundle can start offline on later launches. Without a usable bundle, Clowdy offers Retry or Quit.

Without working Apple secrets the `macos` job warns "Unsigned macOS build" and signs the apps ad hoc. They run, but they cannot update themselves: they show a Download button that opens the latest release instead. Windows builds are unsigned either way; they update, and SmartScreen names no publisher.

## 4. OTA bundles from then on

Every push to `main` that touches `apps/desktop`, `apps/daemon`, `packages`, the root `package.json`, or `bun.lock` runs **Release OTA bundle**. It builds the bundle and publishes `bundle-<number>.tar.gz` and `manifest.json` to the prerelease tagged `ota`. Leave that release and its archives alone: clients may still be downloading an archive named by an earlier manifest. Do not mark it Latest.

A run that publishes nothing says why in a notice at the top of its summary:

| Notice starts with | What to do |
| --- | --- |
| `CLOWDY_OTA_SIGNING_KEY is not set`, `CLOWDY_OTA_PUBLIC_KEY is not set` | Step 1 |
| `No shell is released yet` | Step 3 |
| `Shell <version> is not released yet` | Nothing: the version was just raised, and that shell release carries the bundle |
| `The shell changed since v<version>` | Raise the shell version (step 3); its release carries the bundle |
| `There is no tag v<version>` | The version in `apps/desktop/package.json` was never released: raise it above the newest release |
| `Bundle <number> is out already` | Nothing |

## 5. Open the repository

While the repository is private, installed apps cannot read its releases, so nothing updates. Download installers by hand from **Releases** while signed in. On Windows, `Clowdy-Setup.exe` downloads its package from the release too, so put the matching `clowdy-<version>-<arch>.nsis.7z` next to it before you run it.

When the code is ready to be seen: **Settings → General → Danger Zone → Change repository visibility → Public**. From then on the apps check at launch and hourly, and from **Clowdy → Check for Updates…**.

## 6. Turn on Apple signing

Once the Apple Developer account is verified:

1. **Developer ID certificate.** In Keychain Access choose **Certificate Assistant → Request a Certificate From a Certificate Authority** and save the request to disk. On [developer.apple.com](https://developer.apple.com/account/resources/certificates/list) add a certificate of type **Developer ID Application** with that request, download it, and open it so it lands in your login keychain.
2. **`CSC_LINK` and `CSC_KEY_PASSWORD`.** In Keychain Access → **My Certificates**, right-click "Developer ID Application: …" (it must show its private key under it) → **Export** → `.p12`, with a password. Then set them; without a value, `gh secret set` asks for it:

   ```sh
   base64 -i developer-id.p12 | gh secret set CSC_LINK --repo reforma-ai/clowdy --env desktop-release
   gh secret set CSC_KEY_PASSWORD --repo reforma-ai/clowdy --env desktop-release
   ```

3. **`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.** In [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api) → **Users and Access → Integrations → App Store Connect API → Team Keys**, add a key with **Developer** access and download `AuthKey_<id>.p8` (Apple lets you download it once). The key's ID in the table is `APPLE_API_KEY_ID`, and the Issuer ID above the table is `APPLE_API_ISSUER`:

   ```sh
   base64 -i AuthKey_<id>.p8 | gh secret set APPLE_API_KEY --repo reforma-ai/clowdy --env desktop-release
   gh secret set APPLE_API_KEY_ID --repo reforma-ai/clowdy --env desktop-release
   gh secret set APPLE_API_ISSUER --repo reforma-ai/clowdy --env desktop-release
   ```

4. **`APPLE_TEAM_ID`.** Your Team ID is under **Membership details** on [developer.apple.com](https://developer.apple.com/account) and in the parentheses of the certificate's name. It is a variable, not a secret:

   ```sh
   gh variable set APPLE_TEAM_ID --repo reforma-ai/clowdy --body <team id>
   ```

5. **Check the Apple key before the run.** A bad certificate costs nothing: the `macos` job's "Check the signing certificate" step decodes `CSC_LINK`, opens it with `CSC_KEY_PASSWORD`, and when that fails warns "Unsigned macOS build" and builds ad hoc. A certificate that opens but is not a Developer ID Application one of the team in `APPLE_TEAM_ID` fails the run there instead. A bad App Store Connect key is not checked first: it fails the run after the build, at "Write the App Store Connect key" or "Package, sign, and notarize". Ask Apple with the same three values before you start:

   ```sh
   xcrun notarytool history --key AuthKey_<id>.p8 --key-id <key id> --issuer <issuer id>
   ```

   It lists past submissions (an empty list is fine) or says the credentials are refused.
6. Release a new shell version (step 3). The `macos` job no longer warns, and its "Verify signatures, notarization, and fuses" step checks the notarization and the team. People on an ad-hoc build install the signed one by hand once; it updates itself from then on.

## 7. Install from a terminal

`scripts/install.sh` (macOS) and `scripts/install.ps1` (Windows) install the newest release for someone who pastes one line:

```sh
curl -fsSL https://reforma-ai.github.io/clowdy/install.sh | bash
```

```powershell
irm https://reforma-ai.github.io/clowdy/install.ps1 | iex
```

The macOS script downloads the zip for the computer's processor, checks its SHA-512 against `latest-mac.yml`, checks the app's signature, and puts `Clowdy.app` in `/Applications` (`~/Applications` when that is not writable), with no `sudo`. It stops when Clowdy is running. The Windows script checks `Clowdy-Setup.exe` against `latest.yml` and runs it; the installer then downloads the package of that computer from the release, as it always does. The app updates itself afterwards, so a person runs a script once.

GitHub Pages serves them: `.github/workflows/pages.yml` publishes both files whenever a push to `main` changes them, or by hand from **Actions → Publish install scripts → Run workflow**. Turn Pages on once, before the first run: **Settings → Pages → Build and deployment → Source: GitHub Actions** (a run that finds it off fails, and the manual run repeats it). A custom domain (**Settings → Pages → Custom domain**, with a `CNAME` record at the DNS provider) turns the same files into `https://<domain>/install.sh`, and the old address redirects to it, so a line written in a README keeps working. The raw file works without Pages too: `https://raw.githubusercontent.com/reforma-ai/clowdy/main/scripts/install.sh`. Nothing in the scripts changes with a release: they read the newest release's feed, so they are not published again for one. They work once the repository is public ([step 5](#5-open-the-repository)); a build that is not signed and notarized installs too, but cannot update itself.

Settings, as environment variables, all optional: `CLOWDY_VERSION` (install that version, for example `0.1.2`), `CLOWDY_SILENT` (Windows: run the installer without its window), `CLOWDY_INSTALL_DIR` and `CLOWDY_NO_OPEN` (macOS: the folder to install into, and do not start the app), `CLOWDY_REPO` (another repository), and `CLOWDY_RELEASE_URL` (a folder that holds the feed and the files, in place of the release).

To try the macOS script without a public repository, download `latest-mac.yml` and the zip of a release into an empty folder, serve it (`python3 -m http.server 8000 --bind 127.0.0.1` there), and run `CLOWDY_RELEASE_URL=http://127.0.0.1:8000 CLOWDY_INSTALL_DIR=/tmp/clowdy-try CLOWDY_NO_OPEN=1 bash scripts/install.sh`. On Windows, `CLOWDY_RELEASE_URL` replaces only the download of the installer: it fetches its package from the release itself.

## Check that it works

- **Signed macOS build:** the run's `macos` job shows no "Unsigned macOS build" warning. On a downloaded DMG, `spctl -a -t open --context context:primary-signature -vv Clowdy-arm64.dmg` says `accepted` with `source=Notarized Developer ID`, and `xcrun stapler validate Clowdy-arm64.dmg` says the ticket is valid. After copying the app to `/Applications`, `spctl -a -t exec -vv /Applications/Clowdy.app` says the same.
- **Shell update:** install an older release into `/Applications` and start it. Soon after its window opens, a signed build asks "Clowdy x.y.z is ready to install"; an ad-hoc build says "Clowdy x.y.z is available" and offers Download.
- **OTA update:** after a bundle is published, **Clowdy → Check for Updates…** asks "Clowdy is ready to update" with Restart and Later. Unasked, an "Update ready" toast with Restart appears once no agent run is in progress, and **Settings → About** has the same button at any time.
- **Install script:** on a computer that has no Clowdy, the line of step 7 installs it, and `codesign --verify --deep --strict /Applications/Clowdy.app` passes. Run it again with Clowdy open and it stops with "Clowdy is running".
- **Without GitHub:** `bun scripts/ota-local.ts` in `apps/desktop` serves a test bundle to a development run ([AGENTS.md → Releases](AGENTS.md#releases), "Trying OTA locally").
