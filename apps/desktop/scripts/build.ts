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
 *   runtime/<target>/        the Bun that runs the daemon (`Resources/bun`, `bun-runtime.ts`)
 *
 *   bun scripts/build.ts [target...]    the Bun targets to ship; default: this machine's
 */
import { $ } from 'bun';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { fetchBunRuntimes, runtimeTargets } from './bun-runtime';
import { bundleInfo, layoutDaemonPart } from './bundle';
import { buildMain } from './main-bundle';

const desktopRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const appDir = path.join(desktopRoot, 'app');
const bundleDir = path.join(desktopRoot, 'bundle');
const manifest = await Bun.file(path.join(desktopRoot, 'package.json')).json() as { name: string; version: string; description: string };

const targets = runtimeTargets(process.argv.slice(2));

await rm(appDir, { recursive: true, force: true });
await rm(bundleDir, { recursive: true, force: true });

const info = await bundleInfo();

// The packages the renderer imports; turbo's cache makes a repeat run cheap.
await $`bunx turbo run build --filter=${ '@clowdy/desktop^...' }`.cwd(repoRoot);
await $`bunx vite build --config ${ path.join(desktopRoot, 'vite.config.ts') } --outDir ${ path.join(appDir, 'renderer') } --emptyOutDir`
    .cwd(desktopRoot)
    .env({ ...process.env, NODE_ENV: 'production' });
await buildMain(path.join(appDir, 'dist'));
await layoutDaemonPart(bundleDir, info);
await Bun.write(path.join(appDir, 'bundle.json'), `${ JSON.stringify(info, null, 4) }\n`);
await fetchBunRuntimes(targets);

// The packaged app's own manifest: `productName` names its `userData` folder.
await Bun.write(path.join(appDir, 'package.json'), `${ JSON.stringify({
    name: manifest.name,
    productName: 'Clowdy',
    version: manifest.version,
    description: manifest.description,
    author: 'Clowdy',
    main: 'dist/main/index.cjs',
    private: true,
}, null, 4) }\n`);

console.log(`Built ${ appDir } with bundle ${ info.version }`);
