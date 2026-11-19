/**
 * The app bundle: the part of Clowdy that updates over the air, built from one commit. The packaged app carries one copy
 * (`build.ts`): the renderer inside the ASAR, the daemon and the system skills in `Resources/bundle`.
 *
 *   daemon/main.js, daemon/mcp-stdio.js   the daemon, run by the Bun the shell ships (`bun-runtime.ts`)
 *   system-skills/                        the system skills plugin: `.claude-plugin/plugin.json` and `skills/`
 *
 * Its version is the number of first-parent commits on the branch it was built from: it grows with every commit on
 * `main`, and a shell built from the same commit carries the same number.
 */
import { PROTOCOL_VERSION } from '@clowdy/protocol';
import { $ } from 'bun';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { bundleDaemon } from '../../daemon/scripts/bundle';

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
