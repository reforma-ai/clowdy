/**
 * The ripgrep a packaged app hands to its daemon for searching the contents of files (`CLOWDY_RG`, see
 * `src/main/daemon.ts`), laid out beside Bun: `runtime/<target>/rg` (`rg.exe` on Windows), the licences its archive
 * carries as `ripgrep-<name>`, and `RG_VERSION`, which tells a later run that the folder is current. electron-builder
 * ships the folder as `Resources/bun`, and the app copies it out of the install folder as a whole (`src/main/bundle.ts`).
 *
 * `bun-runtime.ts` downloads, checks, and unpacks the archive below; this file knows which archive that is and what to
 * keep from it. The archives are BurntSushi's own release builds, which run on every machine of their platform: the
 * macOS ones link only the system's libraries, and the Windows ones carry their C runtime.
 *
 * Raising the pinned ripgrep means new hashes here: each release asset has a `.sha256` file beside it that lists its
 * hash, and `gh api repos/BurntSushi/ripgrep/releases/tags/<version>` shows them as `digest`.
 */
import { access, chmod, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RG_VERSION_FILE } from '../src/main/bundle';

import type { RuntimeTarget } from './bun-runtime';

export const RG_VERSION = '15.2.0';

/** ripgrep's archive per target: the tarball on macOS, the zip on Windows. */
export const RG_ARCHIVES: Record<RuntimeTarget, { file: string; sha256: string }> = {
    'darwin-arm64': { file: `ripgrep-${ RG_VERSION }-aarch64-apple-darwin.tar.gz`, sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4' },
    'darwin-x64': { file: `ripgrep-${ RG_VERSION }-x86_64-apple-darwin.tar.gz`, sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1' },
    'win32-x64': { file: `ripgrep-${ RG_VERSION }-x86_64-pc-windows-msvc.zip`, sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5' },
    'win32-arm64': { file: `ripgrep-${ RG_VERSION }-aarch64-pc-windows-msvc.zip`, sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f' },
};

/** The licence texts of the archive (ripgrep is MIT or Unlicense, at your option), kept beside the executable. */
const LICENSES = ['COPYING', 'LICENSE-MIT', 'UNLICENSE'];

export function rgUrl(target: RuntimeTarget): string {
    return `https://github.com/BurntSushi/ripgrep/releases/download/${ RG_VERSION }/${ RG_ARCHIVES[target].file }`;
}

export function rgExecutable(target: RuntimeTarget): string {
    return target.startsWith('win32') ? 'rg.exe' : 'rg';
}

/** Whether `out` (a target's runtime folder) holds this ripgrep, whole: an older one, or an interrupted layout, is not current. */
export async function ripgrepLaidOut(out: string, target: RuntimeTarget): Promise<boolean> {
    const version = await readFile(path.join(out, RG_VERSION_FILE), 'utf8').catch(() => undefined);

    return version?.trim() === RG_VERSION && await access(path.join(out, rgExecutable(target))).then(() => true, () => false);
}

/**
 * Lays out ripgrep in `out` from its archive unpacked into `unpacked`. The version file comes last, so a layout that stops
 * halfway is done again on the next run.
 */
export async function layoutRipgrep(unpacked: string, out: string, target: RuntimeTarget): Promise<void> {
    const exe = rgExecutable(target);
    // The archive holds one folder named after itself, with the executable and the licences in it.
    const [folder] = await readdir(unpacked);

    if (!folder) throw new Error(`${ RG_ARCHIVES[target].file } is empty`);

    await mkdir(out, { recursive: true });
    await copyFile(path.join(unpacked, folder, exe), path.join(out, exe));
    await chmod(path.join(out, exe), 0o755);

    for (const license of LICENSES) await copyFile(path.join(unpacked, folder, license), path.join(out, `ripgrep-${ license }`));

    await writeFile(path.join(out, RG_VERSION_FILE), `${ RG_VERSION }\n`);
}
