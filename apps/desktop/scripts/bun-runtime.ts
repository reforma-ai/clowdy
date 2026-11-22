/**
 * What a packaged app runs its daemon on, one folder per target: `runtime/<target>/bun` (`bun.exe` on Windows) and the
 * ripgrep beside it (`rg`, see `ripgrep.ts`). Bun is the version the repository pins (`packageManager`), downloaded from
 * Bun's releases; both are checked against the hashes pinned here and in `ripgrep.ts`, and cached in `runtime/.cache`.
 * electron-builder ships `runtime/<platform>-${arch}` as `Resources/bun`; its `VERSION` and `RG_VERSION` files name the
 * folder the app copies the runtime into (`src/main/bundle.ts`).
 *
 *   bun scripts/bun-runtime.ts [target...]    default: this machine's
 *
 * Raising the pinned Bun means new hashes here: `SHASUMS256.txt` of that Bun release lists them.
 */
import { $ } from 'bun';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { layoutRipgrep, RG_ARCHIVES, RG_VERSION, rgUrl, ripgrepLaidOut } from './ripgrep';

export type RuntimeTarget = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'win32-arm64';

const BUN_VERSION = '1.4.4';

/** Bun's archive per target. The x64 builds are the baseline ones, which run on CPUs without AVX2. */
const ARCHIVES: Record<RuntimeTarget, { file: string; sha256: string }> = {
    'darwin-arm64': { file: 'bun-darwin-aarch64.zip', sha256: 'c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510' },
    'darwin-x64': { file: 'bun-darwin-x64-baseline.zip', sha256: 'd4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc' },
    'win32-x64': { file: 'bun-windows-x64-baseline.zip', sha256: '0f20ce6674d4f2dbcc8c5d59fdf99f7ba45f8c3b367e0f5781cbfa30a1c78d99' },
    'win32-arm64': { file: 'bun-windows-aarch64.zip', sha256: '2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09' },
};

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_ATTEMPTS = 3;

const desktopRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const runtimeDir = path.join(desktopRoot, 'runtime');
const cacheDir = path.join(runtimeDir, '.cache');

function isRuntimeTarget(value: string): value is RuntimeTarget {
    return value in ARCHIVES;
}

/** The targets named on a command line, or this machine's when none is. Throws on a target the app does not ship for. */
export function runtimeTargets(args: readonly string[]): RuntimeTarget[] {
    const targets = args.length > 0 ? args : [`${ process.platform }-${ process.arch }`];
    const unknown = targets.filter(target => !isRuntimeTarget(target));

    if (unknown.length > 0) throw new Error(`No Bun runtime for ${ unknown.join(', ') }: the app ships for ${ Object.keys(ARCHIVES).join(', ') }`);

    return targets as RuntimeTarget[];
}

/** The Bun every target ships, which the daemon bundle is built for. */
async function pinnedBun(): Promise<string> {
    const { packageManager } = await Bun.file(path.join(repoRoot, 'package.json')).json() as { packageManager: string };
    const pinned = packageManager.replace(/^bun@/, '');

    if (pinned !== BUN_VERSION) {
        throw new Error(`The repository pins Bun ${ pinned }, but scripts/bun-runtime.ts has the hashes of ${ BUN_VERSION }; update them from that release's SHASUMS256.txt`);
    }

    return BUN_VERSION;
}

/** The bytes of `url`, cached at `file` and downloaded first when missing. A stalled download would hang the build, so each attempt has a time limit. */
async function download(url: string, file: string): Promise<Uint8Array> {
    for (let attempt = 1; !await Bun.file(file).exists(); attempt++) {
        console.log(`Downloading ${ url }`);

        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

            if (!response.ok) throw new Error(`${ url }: HTTP ${ response.status }`);

            // Read inside the time limit, which a streamed write to disk does not stop.
            await Bun.write(file, await response.bytes());
        }
        catch (error) {
            await rm(file, { force: true });

            if (attempt === DOWNLOAD_ATTEMPTS) throw error;

            console.warn(`Download attempt ${ attempt } failed: ${ String(error) }`);
        }
    }

    return Bun.file(file).bytes();
}

/** The archive at `url`, cached as `name` and checked against `sha256`; resolves to its path in the cache. */
async function fetchVerified(url: string, name: string, sha256: string): Promise<string> {
    const archive = path.join(cacheDir, `${ sha256.slice(0, 12) }-${ name }`);
    const actual = createHash('sha256').update(await download(url, archive)).digest('hex');

    if (actual !== sha256) {
        await rm(archive, { force: true });
        throw new Error(`${ url }: SHA-256 ${ actual }, expected ${ sha256 }`);
    }

    return archive;
}

/** Unpacks `archive` into a new folder of the cache, hands it to `use`, and deletes it. */
async function withUnpacked(archive: string, use: (unpacked: string) => Promise<void>): Promise<void> {
    const work = await mkdtemp(path.join(cacheDir, 'unpack-'));

    try {
        if (archive.endsWith('.tar.gz')) await $`tar -xzf ${ archive } -C ${ work }`.quiet();
        // bsdtar reads zips on Windows; macOS has unzip.
        else if (process.platform === 'win32') await $`tar -xf ${ archive } -C ${ work }`.quiet();
        else await $`unzip -q -o ${ archive } -d ${ work }`.quiet();

        await use(work);
    }
    finally {
        await rm(work, { recursive: true, force: true });
    }
}

/** Bun, laid out in `out` from its archive; whatever else the folder held is gone. */
async function layBun(target: RuntimeTarget, version: string, out: string): Promise<void> {
    const exe = target.startsWith('win32') ? 'bun.exe' : 'bun';
    const { file, sha256 } = ARCHIVES[target];
    const archive = await fetchVerified(`https://github.com/oven-sh/bun/releases/download/bun-v${ version }/${ file }`, file, sha256);

    await withUnpacked(archive, async (unpacked) => {
        // The archive holds one folder named after itself with the executable inside.
        const [folder] = await readdir(unpacked);

        if (!folder) throw new Error(`${ file } is empty`);

        await rm(out, { recursive: true, force: true });
        await mkdir(out, { recursive: true });
        await copyFile(path.join(unpacked, folder, exe), path.join(out, exe));
        await chmod(path.join(out, exe), 0o755);
        await Bun.write(path.join(out, 'VERSION'), `${ version }\n`);
    });

    console.log(`Bun ${ version } for ${ target } is in ${ out }`);
}

/** The ripgrep of `ripgrep.ts`, laid out in `out` beside Bun. */
async function layRipgrep(target: RuntimeTarget, out: string): Promise<void> {
    const { file, sha256 } = RG_ARCHIVES[target];

    await withUnpacked(await fetchVerified(rgUrl(target), file, sha256), unpacked => layoutRipgrep(unpacked, out, target));

    console.log(`ripgrep ${ RG_VERSION } for ${ target } is in ${ out }`);
}

/** Lays out `runtime/<target>/` (Bun and ripgrep) for each target. What is laid out at the pinned versions is left alone. */
export async function fetchBunRuntimes(targets: readonly RuntimeTarget[]): Promise<void> {
    const version = await pinnedBun();

    await mkdir(cacheDir, { recursive: true });

    for (const target of targets) {
        const exe = target.startsWith('win32') ? 'bun.exe' : 'bun';
        const out = path.join(runtimeDir, target);
        const bunCurrent = await Bun.file(path.join(out, exe)).exists() && await Bun.file(path.join(out, 'VERSION')).exists()
            && (await Bun.file(path.join(out, 'VERSION')).text()).trim() === version;

        if (!bunCurrent) await layBun(target, version, out);

        // After Bun, whose layout empties the folder.
        if (!await ripgrepLaidOut(out, target)) await layRipgrep(target, out);
    }
}

if (import.meta.main) await fetchBunRuntimes(runtimeTargets(process.argv.slice(2)));
