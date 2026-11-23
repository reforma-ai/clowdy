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
import { appendFile, readdir, readFile } from 'node:fs/promises';
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

    const files = (await readdir(releaseDir))
        .filter(name => /\.(dmg|zip|blockmap|exe|7z|yml)$/.test(name) && !name.startsWith('builder-'))
        .map(name => path.join(releaseDir, name));

    if (!files.some(file => file.endsWith('latest-mac.yml')) || !files.some(file => file.endsWith('latest.yml'))) {
        throw new Error('release/ needs latest-mac.yml and latest.yml: a build job did not finish');
    }

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
