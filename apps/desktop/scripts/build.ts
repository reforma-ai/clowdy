/**
 * Release build: the renderer, the main process and the preload, laid out in the `app/` folder
 * that electron-builder packages, and the parts it ships beside the ASAR.
 *
 *   app/package.json         the packaged app's own manifest
 *   app/bundle.json          version, `minShell` and protocol of the bundle the app carries (`bundle.ts`)
 *   app/dist/main/index.cjs  main process
 *   app/dist/preload/index.cjs
 *   app/renderer/            the renderer, served from `app://clowdy`
 *   bundle/                  the daemon and the system skills (`Resources/bundle`)
 *   runtime/<target>/        the Bun that runs the daemon, with the ripgrep it searches with (`Resources/bun`, `bun-runtime.ts`)
 *
 *   bun scripts/build.ts [target...]    the runtime targets to ship; default: this machine's
 *
 * A release build (`.github/workflows/release-shell.yml`) bakes in where updates come from:
 *
 * - `CLOWDY_RELEASE_REPO`: `owner/name` of the GitHub repository with the releases. Without it the app never updates.
 * - `CLOWDY_SIGNED`: `true` when the macOS build gets a Developer ID signature, so it can install the next one itself;
 *   an ad-hoc build offers the release page instead.
 * - `CLOWDY_OTA_PUBLIC_KEY`: the Ed25519 key OTA bundles are signed with (SPKI PEM). Without it the app ignores them.
 */
import { createPublicKey } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { fetchBunRuntimes, runtimeTargets } from './bun-runtime';
import { buildRenderer, bundleInfo, layoutDaemonPart } from './bundle';
import { buildMain } from './main-bundle';

const desktopRoot = path.resolve(import.meta.dir, '..');
const appDir = path.join(desktopRoot, 'app');
const bundleDir = path.join(desktopRoot, 'bundle');
const manifest = await Bun.file(path.join(desktopRoot, 'package.json')).json() as { version: string; description: string };

const targets = runtimeTargets(process.argv.slice(2));

await rm(appDir, { recursive: true, force: true });
await rm(bundleDir, { recursive: true, force: true });

// Checked before the long steps.
const constants = releaseConstants();
const info = await bundleInfo();

await buildRenderer(path.join(appDir, 'renderer'));
await buildMain(path.join(appDir, 'dist'), constants);
await layoutDaemonPart(bundleDir, info);
await Bun.write(path.join(appDir, 'bundle.json'), `${ JSON.stringify(info, null, 4) }\n`);
await fetchBunRuntimes(targets);

// The packaged app's own manifest: `productName` names its `userData` folder. `name` names the Windows packages
// (`clowdy-<version>-<arch>.nsis.7z`) and the updater's cache folder. Not the scoped `@clowdy/desktop`: electron-builder
// would name them `@clowdydesktop-…`, and GitHub renames release assets with special characters, so the web installer
// and the updater, which ask for the name electron-builder wrote, would not find the package.
await Bun.write(path.join(appDir, 'package.json'), `${ JSON.stringify({
    name: 'clowdy',
    productName: 'Clowdy',
    version: manifest.version,
    description: manifest.description,
    author: 'Clowdy',
    main: 'dist/main/index.cjs',
    private: true,
}, null, 4) }\n`);

console.log(`Built ${ appDir } with bundle ${ info.version }`);

/** What `src/main/releaseConfig.ts` reads, from the environment of a release build. */
function releaseConstants(): Record<string, string> {
    const repo = process.env.CLOWDY_RELEASE_REPO ?? '';

    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`CLOWDY_RELEASE_REPO must be owner/name, got ${ repo }`);

    return {
        __CLOWDY_RELEASE_REPO__: JSON.stringify(repo),
        __CLOWDY_SIGNED__: JSON.stringify(process.env.CLOWDY_SIGNED === 'true'),
        __CLOWDY_OTA_PUBLIC_KEY__: JSON.stringify(otaPublicKey()),
    };
}

/**
 * The key OTA bundles are checked with, as SPKI PEM. Exported again from the parsed key, so a private key set by mistake
 * never ships: only its public half would.
 */
function otaPublicKey(): string {
    const pem = process.env.CLOWDY_OTA_PUBLIC_KEY ?? '';

    if (!pem) return '';

    const key = createPublicKey(pem);

    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`CLOWDY_OTA_PUBLIC_KEY must be an Ed25519 key, got ${ key.asymmetricKeyType }`);

    return key.export({ type: 'spki', format: 'pem' }).toString();
}
