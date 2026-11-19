/**
 * Extra checkouts for work that should not share the current branch.
 *
 *   ./clowdy worktree add <slug>
 *   ./clowdy worktree remove <slug>
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function worktreeCommand(repoRoot: string, args: string[]): Promise<void> {
    const [sub, slug, ...rest] = args;

    if ((sub !== 'add' && sub !== 'remove') || rest.length > 0 || !slug || !SLUG.test(slug)) {
        die('Usage: ./clowdy worktree <add|remove> <kebab-case-slug>');
    }

    if (sub === 'add') {
        const created = await addWorktree(repoRoot, slug);
        const install = Bun.spawn(['bun', 'install', '--frozen-lockfile'], {
            cwd: created.path,
            stdio: ['inherit', 'inherit', 'inherit'],
        });
        const code = await install.exited;

        if (code !== 0) {
            die(`Dependencies failed in ${ created.path }. The worktree is still there.`);
        }

        console.log(`Branch: ${ created.branch }`);
        console.log(`Path:   ${ created.path }`);
        return;
    }

    const removed = await removeWorktree(repoRoot, slug);
    console.log(`Removed ${ removed }`);
}

/** `git config user.name` as one kebab-case branch segment. */
export function nicknameFromGitName(name: string): string {
    const nick = name.trim().toLowerCase().replace(/\s+/g, '-');

    if (!SLUG.test(nick)) {
        die(`git config user.name ${ JSON.stringify(name) } is not a single branch segment.`);
    }

    return nick;
}

export async function addWorktree(repoRoot: string, slug: string): Promise<{ branch: string, path: string }> {
    const nick = nicknameFromGitName(await gitName(repoRoot));
    const branch = `${ nick }/${ slug }`;
    const destination = worktreePath(repoRoot, slug);

    await git(repoRoot, ['fetch', 'origin', '--prune']);

    if (await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${ branch }`])) {
        die(`Branch ${ branch } already exists.`);
    }

    if (await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${ branch }`])) {
        die(`Branch ${ branch } already exists on origin.`);
    }

    if (existsSync(destination)) {
        die(`Path already exists: ${ destination }`);
    }

    // --no-track: a start point of origin/main would otherwise set that as upstream.
    await git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, destination, 'origin/main']);

    return { branch, path: destination };
}

export async function removeWorktree(repoRoot: string, slug: string): Promise<string> {
    const destination = worktreePath(repoRoot, slug);

    // No --force: git refuses a checkout that still has uncommitted work.
    await git(repoRoot, ['worktree', 'remove', destination]);

    return destination;
}

export function worktreePath(repoRoot: string, slug: string): string {
    return path.resolve(repoRoot, '..', `clowdy-${ slug }`);
}

async function gitName(repoRoot: string): Promise<string> {
    const result = await gitResult(repoRoot, ['config', 'user.name']);

    if (result.code !== 0 || !result.stdout.trim()) {
        die('git config user.name is empty.');
    }

    return result.stdout.trim();
}

async function git(repoRoot: string, args: string[]): Promise<void> {
    const result = await gitResult(repoRoot, args);

    if (result.code !== 0) {
        die(result.stderr.trim() || result.stdout.trim() || `git ${ args.join(' ') } failed`);
    }
}

async function gitOk(repoRoot: string, args: string[]): Promise<boolean> {
    return (await gitResult(repoRoot, args)).code === 0;
}

async function gitResult(
    repoRoot: string,
    args: string[]
): Promise<{ code: number, stdout: string, stderr: string }> {
    const child = Bun.spawn(['git', ...args], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);

    return { code, stdout, stderr };
}

function die(message: string): never {
    console.error(message);
    process.exit(1);
}
