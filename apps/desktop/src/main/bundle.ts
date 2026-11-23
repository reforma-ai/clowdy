import { randomBytes } from 'node:crypto';
import { access, chmod, cp, readdir, readFile, rename, rm } from 'node:fs/promises';
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

    if (
        !Number.isSafeInteger(value.version) ||
        (value.version ?? 0) <= 0 ||
        typeof value.minShell !== 'string' ||
        !Number.isSafeInteger(value.protocol)
    ) {
        throw new Error('bundle.json does not describe a bundle');
    }

    return { version: value.version!, minShell: value.minShell, protocol: value.protocol! };
}

export async function readBundleInfo(file: string): Promise<BundleInfo> {
    return parseBundleInfo(await readFile(file, 'utf8'));
}

async function exists(file: string): Promise<boolean> {
    return access(file).then(
        () => true,
        () => false
    );
}

/**
 * Copies a folder to `dest` in one step: a copy under another name, then a rename, so `dest` is either whole or absent.
 * `executables`, files in it, are made executable before the rename.
 */
async function copyFolder(source: string, dest: string, executables: readonly string[] = []): Promise<void> {
    const temp = `${dest}.tmp-${randomBytes(4).toString('hex')}`;

    try {
        await cp(source, temp, { recursive: true });

        for (const executable of executables) await chmod(path.join(temp, executable), 0o755);

        await renameWhenFree(temp, dest);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}

/** How long a rename waits for a virus scanner to let go of a file it opened (Windows answers EPERM or EBUSY meanwhile). */
const RENAME_RETRY_MS = [100, 250, 500, 1000, 2000];

/** `rename`, retried while Windows answers that a file in it is busy. */
export async function renameWhenFree(from: string, to: string): Promise<void> {
    for (const delay of [...RENAME_RETRY_MS, undefined]) {
        try {
            await rename(from, to);

            return;
        } catch (error) {
            const busy = ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');

            if (!busy || delay === undefined) throw error;

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * The file in the shipped runtime folder (`Resources/bun`) that names its ripgrep's version, written by
 * `scripts/ripgrep.ts`. A runtime without ripgrep (an old shell's) has none.
 */
export const RG_VERSION_FILE = 'RG_VERSION';

/** The ripgrep executable's name on `platform`. */
function rgName(platform: NodeJS.Platform): string {
    return platform === 'win32' ? 'rg.exe' : 'rg';
}

export interface InstallBunOptions {
    /** `process.resourcesPath`: holds `bun/` (Bun, ripgrep, and their version files) and `bundle/` (daemon and system skills). */
    resources: string;
    /** `updatesDir(dataDir)`. */
    updates: string;
    platform?: NodeJS.Platform;
    arch?: string;
}

/**
 * The Bun the app ships, with the ripgrep beside it, copied to `<updates>/bun/<bun version>-<arch>/`, or
 * `<bun version>-rg<ripgrep version>-<arch>` when the shell ships ripgrep; resolves to Bun's executable. The daemon runs
 * from copies outside the install folder: it outlives the app, and it must never hold files an installer replaces
 * (Windows refuses to overwrite a running `bun.exe`, and a macOS update swaps the whole app). A copy that exists is
 * reused; it is complete, because it appears in one rename. Ripgrep is in the folder's name, so a shell that adds or
 * raises it makes a new copy instead of reusing an older shell's, which has none.
 */
export async function installBun({
    resources,
    updates,
    platform = process.platform,
    arch = process.arch,
}: InstallBunOptions): Promise<string> {
    const exe = platform === 'win32' ? 'bun.exe' : 'bun';
    const source = path.join(resources, 'bun');
    const version = (await readFile(path.join(source, 'VERSION'), 'utf8')).trim();
    const rgVersion = (await readFile(path.join(source, RG_VERSION_FILE), 'utf8').catch(() => '')).trim();
    // Per arch too: a folder moved from an Intel Mac to Apple silicon must not hand over its x64 Bun.
    const dir = path.join(updates, 'bun', `${version}${rgVersion ? `-rg${rgVersion}` : ''}-${arch}`);
    const bun = path.join(dir, exe);

    if (!(await exists(bun))) {
        const rg = rgName(platform);

        await copyFolder(source, dir, (await exists(path.join(source, rg))) ? [exe, rg] : [exe]);
    }

    return bun;
}

/** The ripgrep beside `bun` (what `installBun` copied), or undefined when the runtime has none: the daemon then searches without it. */
export async function installedRipgrep(
    bun: string,
    platform: NodeJS.Platform = process.platform
): Promise<string | undefined> {
    const rg = path.join(path.dirname(bun), rgName(platform));

    return (await exists(rg)) ? rg : undefined;
}

/** The app's own bundle (its daemon and system skills), copied to `<updates>/bundles/<version>/` like Bun; resolves to that folder. */
export async function installOwnBundle({
    resources,
    updates,
    version,
}: {
    resources: string;
    updates: string;
    version: number;
}): Promise<string> {
    const dir = path.join(updates, 'bundles', String(version));

    if (!(await exists(path.join(dir, 'daemon/main.js')))) await copyFolder(path.join(resources, 'bundle'), dir);

    return dir;
}

/** The daemon of a bundle folder (the app's own copy or an installed OTA bundle), run by `bun`, with `rg` to search files when the app has one. */
export function bundleRuntime(bun: string, dir: string, rg?: string): DaemonRuntime {
    return {
        bun,
        entry: path.join(dir, 'daemon/main.js'),
        skillsDir: path.join(dir, 'system-skills'),
        ...(rg && { rg }),
    };
}

/**
 * Deletes the runtime copies (Bun and its ripgrep) other than `bun`'s, left by older shells. Only once the running daemon
 * is one this app started from `bun`: a daemon still running on an older Bun starts its MCP bridge with that executable,
 * and one started with an older `CLOWDY_RG` searches with that ripgrep.
 */
export async function pruneBunCopies(updates: string, bun: string): Promise<void> {
    const parent = path.join(updates, 'bun');
    const keep = path.basename(path.dirname(bun));

    for (const entry of await readdir(parent).catch(() => [] as string[])) {
        // Windows refuses to delete a running executable; the next launch tries again.
        if (entry !== keep) await rm(path.join(parent, entry), { recursive: true, force: true }).catch(() => undefined);
    }
}
