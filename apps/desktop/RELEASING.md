# Setting up releases

What the repository owner sets up once so that GitHub builds Clowdy's installers, publishes OTA bundles, and installed apps update themselves. How the pipeline works is in [AGENTS.md → Releases](AGENTS.md#releases); this page only covers what to configure, where, and in which order.

Everything here lives in the repository settings on GitHub (`kachurun/clowdy` → **Settings**). Nothing goes into `.env` files or the code.

| Name | Kind | Needed for | When |
| --- | --- | --- | --- |
| `CLOWDY_OTA_SIGNING_KEY` | Secret | Signing OTA bundles | Before the first shell release |
| `CLOWDY_OTA_PUBLIC_KEY` | Variable | Baked into every shell, which checks bundles with it | Before the first shell release |
| `CSC_LINK` | Secret | Signing the macOS app | Once the Apple account is verified |
| `CSC_KEY_PASSWORD` | Secret | Opening `CSC_LINK` | Same |
| `APPLE_API_KEY` | Secret | Notarizing the macOS app | Same |
| `APPLE_API_KEY_ID` | Secret | Same | Same |
| `APPLE_API_ISSUER` | Secret | Same | Same |

Secrets go to **Settings → Secrets and variables → Actions → Secrets → New repository secret**. Variables go to the **Variables** tab next to it (**New repository variable**). The workflows' own GitHub token needs nothing: they ask for write access themselves where they publish.

A secret can only be written, never read back, and `gh secret set` replaces one that exists. A placeholder you set earlier is overwritten by setting the name again; the list (`gh secret list --repo reforma-ai/clowdy`) shows only names and dates, so it cannot tell a placeholder from a real value. The workflow can: see step 6.

## 1. Create the OTA key

Do this before the first shell release. A shell carries the public key it was built with, and a shell built without one ignores OTA bundles until the next shell release.

In any folder outside the repository:

```sh
bun -e "const { generateKeyPairSync } = require('node:crypto'); const { writeFileSync } = require('node:fs'); const k = generateKeyPairSync('ed25519'); writeFileSync('ota-private.pem', k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); writeFileSync('ota-public.pem', k.publicKey.export({ type: 'spki', format: 'pem' }));"
```

Put the files into GitHub, either with `gh`:

```sh
gh secret set CLOWDY_OTA_SIGNING_KEY --repo kachurun/clowdy < ota-private.pem
gh variable set CLOWDY_OTA_PUBLIC_KEY --repo kachurun/clowdy < ota-public.pem
```

or by hand: paste the whole of `ota-private.pem`, `BEGIN` and `END` lines included, as the secret `CLOWDY_OTA_SIGNING_KEY`, and `ota-public.pem` as the variable `CLOWDY_OTA_PUBLIC_KEY`.

Then move `ota-private.pem` into your password manager and delete the file. The key never changes casually: shells trust only the key they were built with, so a lost or replaced key means no OTA bundles until a shell built with the new key is out.

## 2. Check that Actions may run

**Settings → Actions → General → Actions permissions** must allow the workflows. The default, "Allow all actions and reusable workflows", works. If you restrict it to selected actions, allow the GitHub-owned ones and `oven-sh/setup-bun@*`.

## 3. Cut a shell release

A release is cut from `main`, which work reaches through the pull request from `next` ([GITFLOW.md → Pull Requests](../../GITFLOW.md#pull-requests)). The repository's ruleset **Protect main** (**Settings → Rules → Rulesets**) must let that merge through: it may require a pull request, but with **Restrict updates** on and nobody on its bypass list every merge stops at "Cannot update this protected ref", whatever the checks say.

Raise `version` in `apps/desktop/package.json` above the newest release (`major.minor.patch` only, for example `0.1.1` to `0.2.0`) in that pull request and merge it. Or open **Actions → Release shell → Run workflow** on `main`, which releases the current version if no release has it yet. A push that keeps the version releases nothing, so to re-run a release that failed, use the manual run.

The run takes about half an hour: `decide`, then `macos` and `windows` side by side, then `publish`. The `windows` job runs the desktop tests first, so a red desktop test stops the release; the other CI checks are not part of it. `publish` runs only when both builds succeed: a failed run publishes nothing and leaves the version unreleased, so fix it and run it again. When it is done, **Releases** shows `v<version>` marked Latest with `Clowdy-arm64.dmg`, `Clowdy-x64.dmg`, `Clowdy-Setup.exe`, the zips, the `clowdy-<version>-<arch>.nsis.7z` packages, `latest-mac.yml`, and `latest.yml`.

Without working Apple secrets the `macos` job warns "Unsigned macOS build" and signs the apps ad hoc. They run, but they cannot update themselves: they show a Download button that opens the latest release instead. Windows builds are unsigned either way; they update, and SmartScreen names no publisher.

## 4. OTA bundles from then on

Every push to `main` that touches `apps/desktop`, `apps/daemon`, `packages`, the root `package.json`, or `bun.lock` runs **Release OTA bundle**. It builds the bundle and publishes `bundle-<number>.tar.gz` and `manifest.json` to the prerelease tagged `ota`. Leave that release alone: don't edit it, delete files from it, or mark it Latest.

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
   base64 -i developer-id.p12 | gh secret set CSC_LINK --repo reforma-ai/clowdy
   gh secret set CSC_KEY_PASSWORD --repo reforma-ai/clowdy
   ```

3. **`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.** In [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api) → **Users and Access → Integrations → App Store Connect API → Team Keys**, add a key with **Developer** access and download `AuthKey_<id>.p8` (Apple lets you download it once). The key's ID in the table is `APPLE_API_KEY_ID`, and the Issuer ID above the table is `APPLE_API_ISSUER`:

   ```sh
   base64 -i AuthKey_<id>.p8 | gh secret set APPLE_API_KEY --repo reforma-ai/clowdy
   gh secret set APPLE_API_KEY_ID --repo reforma-ai/clowdy
   gh secret set APPLE_API_ISSUER --repo reforma-ai/clowdy
   ```

4. **Check the Apple key before the run.** A bad certificate costs nothing: the `macos` job's "Check the signing certificate" step decodes `CSC_LINK`, opens it with `CSC_KEY_PASSWORD`, and when that fails warns "Unsigned macOS build" and builds ad hoc. A bad App Store Connect key is not checked first: it fails the run after the build, at "Write the App Store Connect key" or "Package, sign, and notarize". Ask Apple with the same three values before you start:

   ```sh
   xcrun notarytool history --key AuthKey_<id>.p8 --key-id <key id> --issuer <issuer id>
   ```

   It lists past submissions (an empty list is fine) or says the credentials are refused.
5. Release a new shell version (step 3). The `macos` job no longer warns, and its "Verify signatures, notarization, and fuses" step checks the notarization. People on an ad-hoc build install the signed one by hand once; it updates itself from then on.

## Check that it works

- **Signed macOS build:** the run's `macos` job shows no "Unsigned macOS build" warning. On a downloaded DMG, `spctl -a -t open --context context:primary-signature -vv Clowdy-arm64.dmg` says `accepted` with `source=Notarized Developer ID`, and `xcrun stapler validate Clowdy-arm64.dmg` says the ticket is valid. After copying the app to `/Applications`, `spctl -a -t exec -vv /Applications/Clowdy.app` says the same.
- **Shell update:** install an older release into `/Applications` and start it. Soon after its window opens, a signed build asks "Clowdy x.y.z is ready to install"; an ad-hoc build says "Clowdy x.y.z is available" and offers Download.
- **OTA update:** after a bundle is published, **Clowdy → Check for Updates…** shows an "Update ready" toast with Restart.
- **Without GitHub:** `bun scripts/ota-local.ts` in `apps/desktop` serves a test bundle to a development run ([AGENTS.md → Releases](AGENTS.md#releases), "Trying OTA locally").
