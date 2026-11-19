/**
 * The app bundle: the part of Clowdy that updates over the air, built from one commit. The packaged app carries one copy
 * (`build.ts`): the renderer inside the ASAR, the daemon and the system skills in `Resources/bundle`. An OTA bundle
 * (`buildOtaBundle`, published by `publish-ota.ts`) is all three in one folder, packed into `bundle-<version>.tar.gz`:
 *
 *   renderer/                             the renderer, served from `app://clowdy`
 *   daemon/main.js, daemon/mcp-stdio.js   the daemon, run by the Bun the shell ships (`bun-runtime.ts`)
 *   system-skills/                        the system skills plugin: `.claude-plugin/plugin.json` and `skills/`
 *
 * Its version is the number of first-parent commits on the branch it was built from: it grows with every commit on
 * `main`, and a shell built from the same commit carries the same number.
 */
import { PROTOCOL_VERSION } from '@clowdy/protocol';
import { $ } from 'bun';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { bundleDaemon } from '../../daemon/scripts/bundle';
import { hashFolder, RENDERER_DIR, sha256, type BundleManifest } from '../src/main/bundleManifest';
import { writeTar } from '../src/main/tar';

import type { BundleInfo } from '../src/main/bundle';

const desktopRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const systemSkills = path.join(repoRoot, 'packages/system-skills');

/** The bundle version of the checked-out commit. A shallow clone would count wrong, so it refuses one. */
export async function bundleVersion(): Promise<number> {
    if ((await $`git rev-parse --is-shallow-repository`.cwd(repoRoot).text()).trim() === 'true') {
        throw new Error('The bundle version counts commits, and this clone is shallow: fetch the full history (fetch-depth: 0)');
    }

    return Number((await $`git rev-list --first-parent --count HEAD`.cwd(repoRoot).text()).trim());
}

export async function bundleInfo(): Promise<BundleInfo> {
    const { version: minShell } = await Bun.file(path.join(desktopRoot, 'package.json')).json() as { version: string };

    return { version: await bundleVersion(), minShell, protocol: PROTOCOL_VERSION };
}

/** Lays out the daemon and the system skills of a bundle in `outdir`. */
export async function layoutDaemonPart(outdir: string, info: BundleInfo): Promise<void> {
    await bundleDaemon(path.join(outdir, 'daemon'), String(info.version));
    await mkdir(path.join(outdir, 'system-skills'), { recursive: true });
    // The plugin is its manifest and its skills; the package's scripts and configs stay behind.
    await cp(path.join(systemSkills, '.claude-plugin'), path.join(outdir, 'system-skills/.claude-plugin'), { recursive: true });
    await cp(path.join(systemSkills, 'skills'), path.join(outdir, 'system-skills/skills'), { recursive: true });
}

/** The renderer, built for `app://clowdy` into `outdir`, with the workspace packages it imports built first. */
export async function buildRenderer(outdir: string): Promise<void> {
    // turbo's cache makes a repeat run cheap.
    await $`bunx turbo run build --filter=${ '@clowdy/desktop^...' }`.cwd(repoRoot);
    await $`bunx vite build --config ${ path.join(desktopRoot, 'vite.config.ts') } --outDir ${ outdir } --emptyOutDir`
        .cwd(desktopRoot)
        .env({ ...process.env, NODE_ENV: 'production' });
}

/**
 * An OTA bundle of this commit in `outdir`: the bundle folder (`outdir/bundle`), its archive `bundle-<version>.tar.gz`,
 * and its manifest, unsigned (`publish-ota.ts` signs it).
 */
export async function buildOtaBundle(outdir: string): Promise<{ manifest: BundleManifest; archive: string }> {
    const info = await bundleInfo();
    const folder = path.join(outdir, 'bundle');

    await rm(folder, { recursive: true, force: true });
    await buildRenderer(path.join(folder, RENDERER_DIR));
    await layoutDaemonPart(folder, info);

    const files = await hashFolder(folder);
    const entries = await Promise.all(Object.keys(files).map(async file => ({ path: file, data: await readFile(path.join(folder, file)) })));
    const bytes = gzipSync(writeTar(entries), { level: 9 });
    const name = `bundle-${ info.version }.tar.gz`;
    const archive = path.join(outdir, name);

    await writeFile(archive, bytes);

    return { manifest: { ...info, archive: { name, sha256: sha256(bytes), size: bytes.length }, files }, archive };
}
