/**
 * The GitHub Releases the release scripts read and write, through the `gh` CLI (GitHub Actions has it; `GH_TOKEN` or
 * `gh auth login` authorizes it). `GITHUB_REPOSITORY` names the repository, as in a workflow; without it `gh` uses the
 * checkout's remote. Node APIs only, so Vitest can load the scripts that import it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Release {
    tagName: string;
    isDraft: boolean;
    isPrerelease: boolean;
}

async function gh(args: string[]): Promise<string> {
    const repo = process.env.GITHUB_REPOSITORY ? ['--repo', process.env.GITHUB_REPOSITORY] : [];
    const { stdout } = await run('gh', [...args, ...repo]);

    return stdout;
}

/** Every release, drafts included when the token can push (the newest 200, far more than the repository keeps). */
export async function listReleases(): Promise<Release[]> {
    return JSON.parse(
        await gh(['release', 'list', '--limit', '200', '--json', 'tagName,isDraft,isPrerelease'])
    ) as Release[];
}

export interface CreateRelease {
    tag: string;
    title: string;
    notes: string;
    /** The commit the tag points to once the release is published. */
    target: string;
    draft?: boolean;
    files?: string[];
}

export async function createRelease({ tag, title, notes, target, draft, files = [] }: CreateRelease): Promise<void> {
    await gh([
        'release',
        'create',
        tag,
        '--title',
        title,
        '--notes',
        notes,
        '--target',
        target,
        ...(draft ? ['--draft'] : []),
        ...files,
    ]);
}

/** Publishes a draft and marks it Latest. */
export async function publishAsLatest(tag: string): Promise<void> {
    await gh(['release', 'edit', tag, '--draft=false', '--latest']);
}

/** Deletes a draft. It has no tag yet, so there is none to clean up: `--cleanup-tag` would fail on the missing tag. */
export async function deleteDraft(tag: string): Promise<void> {
    await gh(['release', 'delete', tag, '--yes']);
}

/** Whether `gh` failed because the release or asset does not exist, as opposed to failing to ask. */
function notFound(error: unknown): boolean {
    return /release not found|no assets match|HTTP 404/i.test(String((error as { stderr?: unknown }).stderr ?? error));
}

/** The names of a release's assets, or undefined when there is no release with that tag. */
export async function releaseAssets(tag: string): Promise<string[] | undefined> {
    try {
        return (
            JSON.parse(await gh(['release', 'view', tag, '--json', 'assets'])) as { assets: Array<{ name: string }> }
        ).assets.map(asset => asset.name);
    } catch (error) {
        if (notFound(error)) return undefined;

        throw error;
    }
}

/** Creates a prerelease, which never becomes Latest (what the shell updater follows). */
export async function createPrerelease({
    tag,
    title,
    notes,
    target,
}: Omit<CreateRelease, 'draft' | 'files'>): Promise<void> {
    await gh([
        'release',
        'create',
        tag,
        '--title',
        title,
        '--notes',
        notes,
        '--target',
        target,
        '--prerelease',
        '--latest=false',
    ]);
}

/** Uploads files to a release; `clobber` replaces assets of the same name (a delete, then an upload). */
export async function uploadAssets(tag: string, files: string[], clobber = false): Promise<void> {
    await gh(['release', 'upload', tag, ...(clobber ? ['--clobber'] : []), ...files]);
}

export async function deleteAsset(tag: string, name: string): Promise<void> {
    await gh(['release', 'delete-asset', tag, name, '--yes']);
}

/** An asset as text, or undefined when the release or the asset is missing. */
export async function downloadAsset(tag: string, name: string): Promise<string | undefined> {
    try {
        return await gh(['release', 'download', tag, '--pattern', name, '--output', '-']);
    } catch (error) {
        if (notFound(error)) return undefined;

        throw error;
    }
}

/** Downloads a named binary asset into an empty directory. */
export async function downloadAssetTo(tag: string, name: string, dir: string): Promise<void> {
    await gh(['release', 'download', tag, '--pattern', name, '--dir', dir]);
}
