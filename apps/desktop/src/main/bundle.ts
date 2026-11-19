import { randomBytes } from 'node:crypto';
import { access, chmod, cp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { DaemonRuntime } from './daemon';

/** What a bundle needs from the shell and the daemon it speaks to; `scripts/bundle.ts` writes the app's own as `bundle.json` in the ASAR. */
export interface BundleInfo {
    /** First-parent commit count of the bundle's commit. */
    version: number;
    /** The shell version at that commit: no older shell may run the bundle. */
    minShell: string;
    /** `PROTOCOL_VERSION` of its daemon and its renderer. */
    protocol: number;
}

/**
 * Where updates and the copies the daemon runs from live: beside the daemon's data folder, so in the local app data on
 * Windows (`%LOCALAPPDATA%\Clowdy\updates`) and in `~/Library/Application Support/Clowdy/updates` on macOS.
 */
export function updatesDir(dataDir: string): string {
    return path.join(path.dirname(dataDir), 'updates');
}

export function parseBundleInfo(text: string): BundleInfo {
    const value = JSON.parse(text) as Partial<BundleInfo>;

    if (!Number.isSafeInteger(value.version) || (value.version ?? 0) <= 0
        || typeof value.minShell !== 'string' || !Number.isSafeInteger(value.protocol)) {
        throw new Error('bundle.json does not describe a bundle');
    }

    return { version: value.version!, minShell: value.minShell, protocol: value.protocol! };
}

export async function readBundleInfo(file: string): Promise<BundleInfo> {
    return parseBundleInfo(await readFile(file, 'utf8'));
}

async function exists(file: string): Promise<boolean> {
    return access(file).then(() => true, () => false);
}

/**
 * Copies a folder to `dest` in one step: a copy under another name, then a rename, so `dest` is either whole or absent.
 * `executable`, a file in it, is made executable before the rename.
 */
async function copyFolder(source: string, dest: string, executable?: string): Promise<void> {
    const temp = `${ dest }.tmp-${ randomBytes(4).toString('hex') }`;

    try {
        await cp(source, temp, { recursive: true });

        if (executable) await chmod(path.join(temp, executable), 0o755);

        await renameWhenFree(temp, dest);
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
}

/** How long a rename waits for a virus scanner to let go of a file it opened (Windows answers EPERM or EBUSY meanwhile). */
const RENAME_RETRY_MS = [100, 250, 500, 1000, 2000];

async function renameWhenFree(from: string, to: string): Promise<void> {
    for (const delay of [...RENAME_RETRY_MS, undefined]) {
        try {
            await rename(from, to);

            return;
        }
        catch (error) {
            const busy = ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');

            if (!busy || delay === undefined) throw error;

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

export interface InstallRuntimeOptions {
    /** `process.resourcesPath`: holds `bun/` (the executable and its `VERSION`) and `bundle/` (daemon and system skills). */
    resources: string;
    /** `updatesDir(dataDir)`. */
    updates: string;
    /** The app's own bundle. */
    bundle: BundleInfo;
    platform?: NodeJS.Platform;
    arch?: string;
}

/**
 * The daemon of the app's own bundle, run from copies outside the install folder: `<updates>/bun/<bun version>-<arch>/` and
 * `<updates>/bundles/<bundle version>/`. A daemon outlives the app, and it must never hold files an installer replaces
 * (Windows refuses to overwrite a running `bun.exe`, and a macOS update swaps the whole app). A copy that exists is
 * reused; it is complete, because it appears in one rename.
 */
export async function installRuntime({ resources, updates, bundle, platform = process.platform, arch = process.arch }: InstallRuntimeOptions): Promise<DaemonRuntime> {
    const exe = platform === 'win32' ? 'bun.exe' : 'bun';
    const bunVersion = (await readFile(path.join(resources, 'bun/VERSION'), 'utf8')).trim();
    // Per arch too: a folder moved from an Intel Mac to Apple silicon must not hand over its x64 Bun.
    const bunDir = path.join(updates, 'bun', `${ bunVersion }-${ arch }`);
    const bundleDir = path.join(updates, 'bundles', String(bundle.version));
    const bun = path.join(bunDir, exe);
    const entry = path.join(bundleDir, 'daemon/main.js');

    if (!await exists(bun)) await copyFolder(path.join(resources, 'bun'), bunDir, exe);

    if (!await exists(entry)) await copyFolder(path.join(resources, 'bundle'), bundleDir);

    return { bun, entry, skillsDir: path.join(bundleDir, 'system-skills') };
}
