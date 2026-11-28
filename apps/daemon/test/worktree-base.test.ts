import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readWorktreeBase, resolveWorktreeBase } from '../src/git/worktreeBase';
import { cleanTempDirs, git, makeRepo, tempDir } from './helpers';

afterAll(cleanTempDirs);

test('distinguishes exact missing refs from Git failures and longer prefix matches', async () => {
    const repo = makeRepo(tempDir('worktree-base'), 'repo');
    git(repo, 'branch', 'parent/child');
    expect(await readWorktreeBase(repo, 'parent')).toBeNull();
    expect(await readWorktreeBase(repo, 'parent/child')).toBe(git(repo, 'rev-parse', 'main'));
    expect(await readWorktreeBase(tempDir('not-a-repository'), 'missing')).toBeUndefined();
});

test('does not treat a broken recorded ref as absent', async () => {
    const repo = makeRepo(tempDir('worktree-broken-base'), 'repo');
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'broken'), 'invalid-ref\n');
    expect(await readWorktreeBase(repo, 'broken')).toBeUndefined();
    expect(
        await resolveWorktreeBase(
            'broken',
            () => 'main',
            name => readWorktreeBase(repo, name)
        )
    ).toBeUndefined();
});

describe('resolveWorktreeBase', () => {
    test('keeps an existing recorded base instead of the folder base', async () => {
        const reads: string[] = [];
        const result = await resolveWorktreeBase(
            'recorded',
            () => {
                reads.push('fallback');
                return 'main';
            },
            async name => {
                reads.push(name);
                return name === 'recorded' ? 'old-commit' : 'new-commit';
            }
        );
        expect({ result, reads }).toEqual({ result: { name: 'recorded', commit: 'old-commit' }, reads: ['recorded'] });
    });

    test('falls back only when the recorded ref is absent', async () => {
        const result = await resolveWorktreeBase(
            'gone',
            () => 'main',
            async name => (name === 'gone' ? null : 'main-commit')
        );
        expect(result).toEqual({ name: 'main', commit: 'main-commit' });
    });

    test('never falls back when a recorded ref read is unavailable', async () => {
        const reads: string[] = [];
        const result = await resolveWorktreeBase(
            'unknown',
            () => {
                reads.push('fallback');
                return 'main';
            },
            async name => {
                reads.push(name);
                return name === 'unknown' ? undefined : 'main-commit';
            }
        );
        expect({ result, reads }).toEqual({ result: undefined, reads: ['unknown'] });
    });
});
