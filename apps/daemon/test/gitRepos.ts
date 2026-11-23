import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { WriteEnvironment } from '../src/git/writeEnv';
import { git, makeRepo, tempDir } from './helpers';

/**
 * Real repositories with a bare `origin`, for the tests of what the daemon does to a person's branches. Nothing here touches the network or the person's own git configuration.
 */

/**
 * The environment of the daemon's writes in a test: the person's own git configuration (which on a developer's machine signs every commit, and asks for a fingerprint)
 * and the system's stay out, and the login shell finds no signing agent. What a test repository needs is in its own config.
 */
export const isolated = (extra: Record<string, string> = {}) => new WriteEnvironment({ env: () => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SHELL: '/usr/bin/true', ...extra }) });

/** A bare repository to be somebody's `origin`. */
export function bare(label = 'git-branches'): string {
    const path = join(tempDir(label), 'origin.git');

    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '--bare', '-b', 'main');

    return path;
}

/** Gives a working copy an identity and no signing. */
export function identify(path: string): void {
    git(path, 'config', 'user.name', 'Test');
    git(path, 'config', 'user.email', 'test@example.com');
    git(path, 'config', 'commit.gpgsign', 'false');
}

/** A repository on `main` whose `origin` is `origin` and which has pushed `main` there, so it tracks `origin/main`. */
export function repository(origin = bare()): { path: string; origin: string } {
    const path = makeRepo(tempDir('git-branches'));

    identify(path);
    git(path, 'remote', 'add', 'origin', origin);
    git(path, 'push', '-q', '-u', 'origin', 'main');

    return { path, origin };
}

/** Another working copy of `origin`: where somebody else's work comes from. */
export function neighbour(origin: string): string {
    const path = join(tempDir('git-branches'), 'neighbour');

    git(dirname(path), 'clone', '-q', origin, path);
    identify(path);

    return path;
}

/** Writes a file and commits it on the branch that is checked out. */
export function commitFile(path: string, name: string, text = `${ name }\n`): string {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), text);
    git(path, 'add', name);
    git(path, 'commit', '-q', '-m', `Add ${ name }`);

    return git(path, 'rev-parse', 'HEAD');
}

/** A hook of a working copy, or of a bare repository (whose `hooks` folder is its own). */
export function hook(path: string, name: string, ...lines: string[]): void {
    const file = existsSync(join(path, '.git')) ? join(path, '.git', 'hooks', name) : join(path, 'hooks', name);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ['#!/bin/sh', ...lines].join('\n'));
    chmodSync(file, 0o755);
}

/** What is left in the tree and the index as `status --porcelain` says it. */
export const left = (path: string): string[] => Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: path, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().split('\n').filter(line => line !== '').sort();

/** Every ref of a repository with the commit it is at. */
export const refsOf = (path: string): string => git(path, 'for-each-ref', '--format=%(refname) %(objectname)');

/** Makes many refs at once, which is how a repository gets hundreds of branches in a moment: `names` are full ref names, all at `commit`. */
export function makeRefs(path: string, names: string[], commit = 'HEAD'): void {
    const sha = git(path, 'rev-parse', commit);
    const result = Bun.spawnSync(['git', 'update-ref', '--stdin'], { cwd: path, stdin: new TextEncoder().encode(names.map(name => `create ${ name } ${ sha }\n`).join('')), stdout: 'pipe', stderr: 'pipe' });

    if (result.exitCode !== 0) throw new Error(`update-ref failed: ${ result.stderr.toString() }`);
}

/** Writes a file and commits it with a fixed date, so the order of branches by their newest commit is the test's own. */
export function commitFileAt(path: string, name: string, when: string): string {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), `${ name }\n`);
    git(path, 'add', name);

    const result = Bun.spawnSync(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Add ${ name }`], {
        cwd: path,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });

    if (result.exitCode !== 0) throw new Error(`commit failed: ${ result.stderr.toString() }`);

    return git(path, 'rev-parse', 'HEAD');
}
