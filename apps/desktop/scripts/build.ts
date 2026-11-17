/**
 * Release build: the renderer, the main process and the preload, laid out in the `app/` folder
 * that electron-builder packages.
 *
 *   app/package.json         the packaged app's own manifest
 *   app/dist/main/index.cjs  main process
 *   app/dist/preload/index.cjs
 *   app/renderer/            the renderer, served from `app://clowdy`
 */
import { $ } from 'bun';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { buildMain } from './main-bundle';

const desktopRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const appDir = path.join(desktopRoot, 'app');
const manifest = await Bun.file(path.join(desktopRoot, 'package.json')).json() as { name: string; version: string; description: string };

await rm(appDir, { recursive: true, force: true });

// The packages the renderer imports; turbo's cache makes a repeat run cheap.
await $`bunx turbo run build --filter=${ '@clowdy/desktop^...' }`.cwd(repoRoot);
await $`bunx vite build --config ${ path.join(desktopRoot, 'vite.config.ts') } --outDir ${ path.join(appDir, 'renderer') } --emptyOutDir`
    .cwd(desktopRoot)
    .env({ ...process.env, NODE_ENV: 'production' });
await buildMain(path.join(appDir, 'dist'));

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

console.log(`Built ${ appDir }`);
