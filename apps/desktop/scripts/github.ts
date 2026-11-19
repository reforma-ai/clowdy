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
    return JSON.parse(await gh(['release', 'list', '--limit', '200', '--json', 'tagName,isDraft,isPrerelease'])) as Release[];
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
    await gh(['release', 'create', tag, '--title', title, '--notes', notes, '--target', target, ...draft ? ['--draft'] : [], ...files]);
}

/** Publishes a draft and marks it Latest. */
export async function publishAsLatest(tag: string): Promise<void> {
    await gh(['release', 'edit', tag, '--draft=false', '--latest']);
}

/** Deletes a draft. It has no tag yet, so there is none to clean up: `--cleanup-tag` would fail on the missing tag. */
export async function deleteDraft(tag: string): Promise<void> {
    await gh(['release', 'delete', tag, '--yes']);
}
