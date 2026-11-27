/**
 * Shell releases on GitHub, for .github/workflows/release-shell.yml.
 *
 *   bun scripts/release-shell.ts decide     `decision` (build, skip, or fail) for the workflow
 *   bun scripts/release-shell.ts publish    uploads `release/` as a draft `v<version>`, then publishes it as Latest
 *
 * A release is cut by raising `version` in apps/desktop/package.json on main. A push that leaves the version as it was
 * (a new dependency, say) releases nothing; a manual run releases the current version if it is not out yet. A version
 * is released once: a bad release is replaced by a higher version, never rewritten.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, open, readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isVersionAheadOf } from '@clowdy/lib/semver';

import { createRelease, deleteDraft, listReleases, publishAsLatest, type Release } from './github';

// Not `import.meta.dir`: Vitest loads this file in Node.
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const releaseDir = path.join(desktopRoot, 'release');
const run = promisify(execFile);
const require = createRequire(import.meta.url);

/** What the release workflow does with the shell version at the pushed commit. */
export type ShellDecision = { decision: 'build' | 'skip' | 'fail'; reason: string };

export interface ShellDecisionInput {
    /** `version` in apps/desktop/package.json at the commit being released. */
    version: string;
    /** The same before the push; null when it cannot be read, undefined for a manual run. */
    previous?: string | null;
    releases: readonly Release[];
}

export const shellTag = (version: string) => `v${version}`;

/** Refuse missing, empty, or obviously malformed installer artifacts before a release is created. */
export async function validateShellArtifacts(dir: string, version: string): Promise<void> {
    const expected: Array<[string, Buffer, number]> = [
        ['Clowdy-arm64.dmg', Buffer.from('koly'), -512],
        ['Clowdy-x64.dmg', Buffer.from('koly'), -512],
        [`Clowdy-${version}-arm64.zip`, Buffer.from('504b0304', 'hex'), 0],
        [`Clowdy-${version}-x64.zip`, Buffer.from('504b0304', 'hex'), 0],
        ['Clowdy-Setup.exe', Buffer.from('MZ'), 0],
        [`clowdy-${version}-x64.nsis.7z`, Buffer.from('377abcaf271c', 'hex'), 0],
        [`clowdy-${version}-arm64.nsis.7z`, Buffer.from('377abcaf271c', 'hex'), 0],
    ];
    for (const [name, magic, offset] of expected) {
        const file = path.join(dir, name);
        const size = (await stat(file).catch(() => null))?.size ?? 0;
        if (size < Math.max(magic.length, -offset)) throw new Error(`Missing or malformed installer ${name}`);
        const handle = await open(file, 'r');
        try {
            const bytes = Buffer.alloc(magic.length);
            await handle.read(bytes, 0, bytes.length, offset < 0 ? size + offset : offset);
            if (!bytes.equals(magic)) throw new Error(`Malformed installer ${name}`);
        } finally {
            await handle.close();
        }
    }
    type FileInfo = { url?: string; path?: string; sha512?: string; size?: number };
    type Feed = { version?: string; files?: FileInfo[]; packages?: Record<string, FileInfo> };
    const yaml = require('js-yaml') as { load: (input: string) => unknown };
    const verify = async (entry: FileInfo | undefined, name: string, requireSize = true) => {
        if (
            !entry ||
            (entry.url ?? entry.path) !== name ||
            (entry.size !== undefined && !Number.isSafeInteger(entry.size)) ||
            (requireSize && entry.size === undefined) ||
            typeof entry.sha512 !== 'string' ||
            !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512)
        ) {
            throw new Error(`Malformed update entry ${name}`);
        }
        const file = path.join(dir, name);
        if (entry.size !== undefined && (await stat(file)).size !== entry.size)
            throw new Error(`Wrong size for ${name}`);
        const hash = createHash('sha512');
        for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
        if (hash.digest('base64') !== entry.sha512) throw new Error(`Wrong hash for ${name}`);
    };
    for (const name of ['latest-mac.yml', 'latest.yml']) {
        const feed = yaml.load(await readFile(path.join(dir, name), 'utf8')) as Feed | null;
        if (!feed || feed.version !== version || !Array.isArray(feed.files))
            throw new Error(`Malformed update feed ${name}`);
        if (name === 'latest-mac.yml') {
            for (const arch of ['arm64', 'x64']) {
                const file = `Clowdy-${version}-${arch}.zip`;
                await verify(
                    feed.files.find(entry => entry.url === file),
                    file
                );
            }
        } else {
            await verify(
                feed.files.find(entry => entry.url === 'Clowdy-Setup.exe'),
                'Clowdy-Setup.exe',
                false
            );
            for (const arch of ['x64', 'arm64'])
                await verify(feed.packages?.[arch], `clowdy-${version}-${arch}.nsis.7z`);
        }
    }
}

/** The archives must contain the runnable shell and its native runtime, not just be well-formed archives. */
export function checkShellListing(listing: string, platform: 'mac' | 'mac-dmg' | 'win'): void {
    const entries = listing.split(/\r?\n\r?\n/).map(block => ({
        path: /^Path = (.+)$/m.exec(block)?.[1],
        size: Number(/^Size = (\d+)$/m.exec(block)?.[1] ?? 0),
    }));
    let prefix = '';
    if (platform === 'mac-dmg') {
        const suffix = 'Clowdy.app/Contents/MacOS/Clowdy';
        const matches = entries.filter(entry => entry.path?.endsWith(`/${suffix}`));
        if (matches.length !== 1) throw new Error('Disk image lacks a unique Clowdy application');
        prefix = matches[0]!.path!.slice(0, -suffix.length);
    }
    const required =
        platform !== 'win'
            ? [
                  'Clowdy.app/Contents/MacOS/Clowdy',
                  'Clowdy.app/Contents/Resources/app.asar',
                  'Clowdy.app/Contents/Resources/bun/bun',
                  'Clowdy.app/Contents/Resources/bun/rg',
              ]
            : ['Clowdy.exe', 'resources/app.asar', 'resources/bun/bun.exe', 'resources/bun/rg.exe'];
    for (const item of required) {
        const name = prefix + item;
        const matches = entries.filter(entry => entry.path === name);
        if (matches.length !== 1 || matches[0]!.size <= 0) throw new Error(`Archive lacks a usable ${name}`);
    }
}

/** Decompress and check each distributable, including the NSIS executable, before publishing. */
export async function verifyShellArchives(dir: string, version: string, sevenZip = '7z'): Promise<void> {
    const files = [
        'Clowdy-arm64.dmg',
        'Clowdy-x64.dmg',
        `Clowdy-${version}-arm64.zip`,
        `Clowdy-${version}-x64.zip`,
        'Clowdy-Setup.exe',
        `clowdy-${version}-x64.nsis.7z`,
        `clowdy-${version}-arm64.nsis.7z`,
    ];
    for (const name of files) {
        await run(sevenZip, ['t', '-bd', path.join(dir, name)], { maxBuffer: 4 * 1024 * 1024 });
        if (name.endsWith('.zip') || name.endsWith('.nsis.7z') || name.endsWith('.dmg')) {
            const { stdout } = await run(sevenZip, ['l', '-slt', path.join(dir, name)], { maxBuffer: 4 * 1024 * 1024 });
            checkShellListing(stdout, name.endsWith('.dmg') ? 'mac-dmg' : name.endsWith('.zip') ? 'mac' : 'win');
        }
    }
}

/** A published shell release: not a draft or a prerelease (the `ota` one is), tagged `v<major.minor.patch>`. */
const isShellRelease = (release: Release) =>
    !release.isDraft && !release.isPrerelease && /^v\d+\.\d+\.\d+$/.test(release.tagName);

/** The newest published shell version; null before the first release. */
export function newestShell(releases: readonly Release[]): string | null {
    return releases
        .filter(isShellRelease)
        .map(release => release.tagName.slice(1))
        .reduce<string | null>(
            (best, version) => (best === null || isVersionAheadOf(version, best) ? version : best),
            null
        );
}

export function decideShell({ version, previous, releases }: ShellDecisionInput): ShellDecision {
    const verdict = (decision: ShellDecision['decision'], reason: string): ShellDecision => ({ decision, reason });

    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        return verdict(
            'fail',
            `The shell version ${version} is not major.minor.patch: electron-builder would write a channel feed for it`
        );
    }

    if (previous !== undefined && previous === version) return verdict('skip', `The shell version stays ${version}`);

    if (releases.some(release => isShellRelease(release) && release.tagName === shellTag(version)))
        return verdict('skip', `Clowdy ${version} is out already`);

    const newest = newestShell(releases);

    if (newest !== null && !isVersionAheadOf(version, newest)) {
        return verdict('fail', `The shell version ${version} is not above the newest release, ${newest}`);
    }

    return verdict('build', `Releasing Clowdy ${version}`);
}

/** `version` in apps/desktop/package.json, in the checkout or at a commit; null when that commit does not have it. */
async function packageVersion(ref?: string): Promise<string | null> {
    try {
        const text = ref
            ? (await run('git', ['show', `${ref}:apps/desktop/package.json`], { cwd: repoRoot })).stdout
            : await readFile(path.join(desktopRoot, 'package.json'), 'utf8');

        return (JSON.parse(text) as { version: string }).version;
    } catch {
        return null;
    }
}

/** A line for the step's outputs (`$GITHUB_OUTPUT`), or the console outside a workflow. */
async function output(name: string, value: string): Promise<void> {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    else console.log(`${name}=${value}`);
}

async function decide(): Promise<void> {
    // A push names the commit before it; a manual run has none.
    const before = process.env.BEFORE_SHA;
    const result = decideShell({
        version: (await packageVersion())!,
        previous: before && !/^0+$/.test(before) ? await packageVersion(before) : undefined,
        releases: await listReleases(),
    });

    console.log(result.reason);
    await output('decision', result.decision);

    if (result.decision === 'fail') process.exit(1);
}

/**
 * Every file the build jobs produced, flat in `release/`. It decides again from the releases as they are now, so a
 * re-run of this job alone neither rewrites a version nor makes an older one Latest. A draft of the same version left
 * by a failed run is replaced.
 */
async function publish(): Promise<void> {
    const version = (await packageVersion())!;
    const tag = shellTag(version);
    const releases = await listReleases();
    const { decision, reason } = decideShell({ version, releases });

    if (decision === 'skip') {
        console.log(reason);

        return;
    }

    if (decision === 'fail') throw new Error(reason);

    const publicKey = process.env.CLOWDY_OTA_PUBLIC_KEY;
    if (!publicKey) throw new Error('CLOWDY_OTA_PUBLIC_KEY is required to publish a shell');
    const { verifyBootstrap } = await import('./publish-ota');
    const archive = await verifyBootstrap(releaseDir, publicKey, version);

    const files = (await readdir(releaseDir))
        .filter(name => /\.(dmg|zip|blockmap|exe|7z|yml)$/.test(name) && !name.startsWith('builder-'))
        .map(name => path.join(releaseDir, name));

    files.push(path.join(releaseDir, 'manifest.json'), path.join(releaseDir, archive));

    if (!files.some(file => file.endsWith('latest-mac.yml')) || !files.some(file => file.endsWith('latest.yml'))) {
        throw new Error('release/ needs latest-mac.yml and latest.yml: a build job did not finish');
    }

    await validateShellArtifacts(releaseDir, version);
    await verifyShellArchives(releaseDir, version);

    if (releases.some(release => release.tagName === tag && release.isDraft)) await deleteDraft(tag);

    await createRelease({
        tag,
        title: `Clowdy ${version}`,
        notes: `Clowdy ${version}. Download the .dmg for your Mac (arm64 for Apple silicon) or Clowdy-Setup.exe for Windows.`,
        target: process.env.GITHUB_SHA ?? (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim(),
        draft: true,
        files,
    });
    // Published last, so the updater never sees a Latest release without its files.
    await publishAsLatest(tag);
    console.log(`Published Clowdy ${version} with ${files.length} files`);
}

if (import.meta.main) {
    const [command] = process.argv.slice(2);

    if (command === 'decide') await decide();
    else if (command === 'publish') await publish();
    else {
        console.error('Usage: bun scripts/release-shell.ts decide|publish');
        process.exit(1);
    }
}
