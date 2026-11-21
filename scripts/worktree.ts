/**
 * Extra checkouts for work that should not share the working branch (GITFLOW.md, Worktrees).
 * `add` starts from the local branch `next` by name, whatever the checkout it runs in has checked out, or from
 * `--from <ref>`; a ref of `origin` is fetched first.
 *
 *   ./clowdy worktree add <slug> [--from <ref>]
 *   ./clowdy worktree remove <slug>
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const USAGE = 'Usage: ./clowdy worktree add <kebab-case-slug> [--from <ref>] | remove <kebab-case-slug>';

/** The branch all local work is committed on, and so what an isolated branch starts from and returns to. */
const WORKING_BRANCH = 'next';

export async function worktreeCommand(repoRoot: string, args: string[]): Promise<void> {
    const [sub, slug, ...rest] = args;

    if ((sub !== 'add' && sub !== 'remove') || !slug || !SLUG.test(slug)) {
        die(USAGE);
    }

    if (sub === 'add') {
        const created = await addWorktree(repoRoot, slug, parseFrom(rest));
        const install = Bun.spawn(['bun', 'install', '--frozen-lockfile'], {
            cwd: created.path,
            stdio: ['inherit', 'inherit', 'inherit'],
        });
        const code = await install.exited;

        if (code !== 0) {
            die(`Dependencies failed in ${ created.path }. The worktree is still there.`);
        }

        console.log(`Branch: ${ created.branch }`);
        console.log(`From:   ${ created.from } (${ created.base })`);
        console.log(`Path:   ${ created.path }`);
        return;
    }

    if (rest.length > 0) {
        die(USAGE);
    }

    const removed = await removeWorktree(repoRoot, slug);
    console.log(`Removed ${ removed }`);
}

/** The ref after `--from`, or nothing for the working branch. */
function parseFrom(rest: string[]): string | undefined {
    if (rest.length === 0) {
        return undefined;
    }

    if (rest.length === 2 && rest[0] === '--from' && rest[1]) {
        return rest[1];
    }

    return die(USAGE);
}

/** `git config user.name` as one kebab-case branch segment. */
export function nicknameFromGitName(name: string): string {
    const nick = name.trim().toLowerCase().replace(/\s+/g, '-');

    if (!SLUG.test(nick)) {
        die(`git config user.name ${ JSON.stringify(name) } is not a single branch segment.`);
    }

    return nick;
}

export async function addWorktree(
    repoRoot: string,
    slug: string,
    from = WORKING_BRANCH
): Promise<{ branch: string, path: string, from: string, base: string }> {
    const nick = nicknameFromGitName(await gitName(repoRoot));
    const branch = `${ nick }/${ slug }`;
    const destination = worktreePath(repoRoot, slug);

    // A ref of origin is only as new as the last fetch, so the one who asked for it gets it fresh. The default is local
    // and needs no network: a fetch asks for the owner's SSH key, which an agent session does not hold.
    if (from.startsWith('origin/')) {
        await git(repoRoot, ['fetch', 'origin', '--prune']);
    }

    const base = await gitResult(repoRoot, ['rev-parse', '--verify', '--quiet', '--short', `${ from }^{commit}`]);

    if (base.code !== 0) {
        die(`There is no ${ from } to start from. Name another ref: ./clowdy worktree add ${ slug } --from <ref>`);
    }

    if (await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${ branch }`])) {
        die(`Branch ${ branch } already exists.`);
    }

    if (await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${ branch }`])) {
        die(`Branch ${ branch } already exists on origin.`);
    }

    if (existsSync(destination)) {
        die(`Path already exists: ${ destination }`);
    }

    // --no-track keeps the new branch off any upstream, which a start point of origin/... would set.
    await git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, destination, from]);

    return { branch, path: destination, from, base: base.stdout.trim() };
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
