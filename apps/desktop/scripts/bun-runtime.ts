/**
 * The Bun a packaged app runs its daemon on, one per target: `runtime/<target>/bun` (`bun.exe` on Windows). It is the
 * version the repository pins (`packageManager`), downloaded from Bun's releases, checked against the hashes below, and
 * cached in `runtime/.cache`. electron-builder ships `runtime/<platform>-${arch}` as `Resources/bun`; its `VERSION` file
 * names the folder the app copies Bun into (`src/main/bundle.ts`).
 *
 *   bun scripts/bun-runtime.ts [target...]    default: this machine's
 *
 * Raising the pinned Bun means new hashes here: `SHASUMS256.txt` of that Bun release lists them.
 */
import { $ } from 'bun';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

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

/** Lays out `runtime/<target>/bun` for each target. A target already laid out is left alone. */
export async function fetchBunRuntimes(targets: readonly RuntimeTarget[]): Promise<void> {
    const version = await pinnedBun();

    await mkdir(cacheDir, { recursive: true });

    for (const target of targets) {
        const exe = target.startsWith('win32') ? 'bun.exe' : 'bun';
        const out = path.join(runtimeDir, target);

        if (await Bun.file(path.join(out, exe)).exists() && await Bun.file(path.join(out, 'VERSION')).exists()
            && (await Bun.file(path.join(out, 'VERSION')).text()).trim() === version) continue;

        const { file, sha256 } = ARCHIVES[target];
        const url = `https://github.com/oven-sh/bun/releases/download/bun-v${ version }/${ file }`;
        const archive = path.join(cacheDir, `${ sha256.slice(0, 12) }-${ file }`);
        const actual = createHash('sha256').update(await download(url, archive)).digest('hex');

        if (actual !== sha256) {
            await rm(archive, { force: true });
            throw new Error(`${ url }: SHA-256 ${ actual }, expected ${ sha256 }`);
        }

        const work = await mkdtemp(path.join(cacheDir, 'unpack-'));

        try {
            // bsdtar reads zips on Windows; macOS has unzip.
            if (process.platform === 'win32') await $`tar -xf ${ archive } -C ${ work }`.quiet();
            else await $`unzip -q -o ${ archive } -d ${ work }`.quiet();

            // The archive holds one folder named after itself with the executable inside.
            const [folder] = await readdir(work);

            if (!folder) throw new Error(`${ file } is empty`);

            await rm(out, { recursive: true, force: true });
            await mkdir(out, { recursive: true });
            await copyFile(path.join(work, folder, exe), path.join(out, exe));
            await chmod(path.join(out, exe), 0o755);
            await Bun.write(path.join(out, 'VERSION'), `${ version }\n`);
        }
        finally {
            await rm(work, { recursive: true, force: true });
        }

        console.log(`Bun ${ version } for ${ target } is in ${ out }`);
    }
}

if (import.meta.main) await fetchBunRuntimes(runtimeTargets(process.argv.slice(2)));
