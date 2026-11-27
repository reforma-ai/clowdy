import { afterEach, describe, expect, test } from 'bun:test';
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { briefbackStatus, checkBriefbackUpdate, installBriefback } from '../src/skills/briefback';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'clowdy-briefback-test-'));
    dirs.push(dir);
    const roots = [join(dir, 'claude', 'skills'), join(dir, 'agents', 'skills')];
    const source = join(dir, 'source');
    mkdirSync(join(source, 'references'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: briefback\ndescription: A workflow\n---\n# Briefback\n');
    writeFileSync(join(source, 'references', 'review.md'), 'Review');
    return { roots, source };
}

describe('Briefback installation', () => {
    test('installs the complete skill into both global roots', async () => {
        const { roots, source } = setup();
        const initial = briefbackStatus(roots);
        expect(initial.copies).toEqual([
            { exists: false, installed: false },
            { exists: false, installed: false },
        ]);
        const installed = await installBriefback(roots, initial.fingerprint, { source });
        expect(installed.copies).toEqual([
            { exists: true, installed: true },
            { exists: true, installed: true },
        ]);
        expect(readFileSync(join(roots[0]!, 'briefback', 'references', 'review.md'), 'utf8')).toBe('Review');
        expect(readFileSync(join(roots[1]!, 'briefback', 'references', 'review.md'), 'utf8')).toBe('Review');
    });

    test('replaces a confirmed partial installation and fills the missing copy', async () => {
        const { roots, source } = setup();
        mkdirSync(join(roots[0]!, 'briefback'), { recursive: true });
        writeFileSync(join(roots[0]!, 'briefback', 'old.txt'), 'old');
        const status = briefbackStatus(roots);
        expect(status.copies).toEqual([
            { exists: true, installed: false },
            { exists: false, installed: false },
        ]);
        await installBriefback(roots, status.fingerprint, { source });
        expect(briefbackStatus(roots).copies).toEqual([
            { exists: true, installed: true },
            { exists: true, installed: true },
        ]);
        expect(() => readFileSync(join(roots[0]!, 'briefback', 'old.txt'))).toThrow();
    });

    test('rejects a stale confirmation without changing an existing skill', async () => {
        const { roots, source } = setup();
        const status = briefbackStatus(roots);
        mkdirSync(join(roots[0]!, 'briefback'), { recursive: true });
        writeFileSync(join(roots[0]!, 'briefback', 'SKILL.md'), 'new user copy');
        await expect(installBriefback(roots, status.fingerprint, { source })).rejects.toMatchObject({
            code: 'conflict',
        });
        expect(readFileSync(join(roots[0]!, 'briefback', 'SKILL.md'), 'utf8')).toBe('new user copy');
        expect(briefbackStatus(roots).copies[1]).toEqual({ exists: false, installed: false });
    });

    test('rejects an unsafe source while preserving an existing installation', async () => {
        const { roots, source } = setup();
        mkdirSync(join(roots[0]!, 'briefback'), { recursive: true });
        writeFileSync(join(roots[0]!, 'briefback', 'SKILL.md'), 'user copy');
        symlinkSync('/etc/passwd', join(source, 'references', 'unsafe'));
        const status = briefbackStatus(roots);
        await expect(installBriefback(roots, status.fingerprint, { source })).rejects.toThrow();
        expect(readFileSync(join(roots[0]!, 'briefback', 'SKILL.md'), 'utf8')).toBe('user copy');
        expect(briefbackStatus(roots).copies[1]).toEqual({ exists: false, installed: false });
    });

    test('restores the first existing copy when the second changes during installation', async () => {
        const { roots, source } = setup();
        mkdirSync(join(roots[0]!, 'briefback'), { recursive: true });
        writeFileSync(join(roots[0]!, 'briefback', 'SKILL.md'), 'old copy');
        const status = briefbackStatus(roots);
        await expect(
            installBriefback(roots, status.fingerprint, {
                source,
                onCopyInstalled(index) {
                    if (index === 0) {
                        mkdirSync(join(roots[1]!, 'briefback'));
                        writeFileSync(join(roots[1]!, 'briefback', 'SKILL.md'), 'new user copy');
                    }
                },
            })
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(readFileSync(join(roots[0]!, 'briefback', 'SKILL.md'), 'utf8')).toBe('old copy');
        expect(readFileSync(join(roots[1]!, 'briefback', 'SKILL.md'), 'utf8')).toBe('new user copy');
    });

    test('rejects a second install with the same stale confirmation', async () => {
        const { roots, source } = setup();
        const status = briefbackStatus(roots);
        const first = installBriefback(roots, status.fingerprint, { source });
        const second = installBriefback(roots, status.fingerprint, { source });
        await first;
        await expect(second).rejects.toMatchObject({ code: 'conflict' });
        expect(briefbackStatus(roots).copies).toEqual([
            { exists: true, installed: true },
            { exists: true, installed: true },
        ]);
    });
});

test('reports a partial copy when a mode referenced by SKILL.md is missing', () => {
    const { roots } = setup();
    for (const root of roots) {
        mkdirSync(join(root, 'briefback'), { recursive: true });
        writeFileSync(
            join(root, 'briefback', 'SKILL.md'),
            '---\nname: briefback\ndescription: A workflow\n---\n[review](references/review.md)'
        );
    }
    expect(briefbackStatus(roots).copies).toEqual([
        { exists: true, installed: false },
        { exists: true, installed: false },
    ]);
});

test('preserves a concurrently changed new copy and its original backup during rollback', async () => {
    const { roots, source } = setup();
    mkdirSync(join(roots[0]!, 'briefback'), { recursive: true });
    writeFileSync(join(roots[0]!, 'briefback', 'SKILL.md'), 'original');
    const status = briefbackStatus(roots);
    let failure: unknown;
    try {
        await installBriefback(roots, status.fingerprint, {
            source,
            onCopyInstalled(index) {
                if (index === 0) {
                    writeFileSync(join(roots[0]!, 'briefback', 'external.txt'), 'user data');
                    mkdirSync(join(roots[1]!, 'briefback'));
                }
            },
        });
    } catch (error) {
        failure = error;
    }
    expect(failure).toMatchObject({ code: 'unavailable' });
    expect(readFileSync(join(roots[0]!, 'briefback', 'external.txt'), 'utf8')).toBe('user data');
    const message = (failure as Error).message;
    const backup = message.slice(message.indexOf('backups are kept in ') + 'backups are kept in '.length);
    expect(readFileSync(join(backup, 'backup', 'SKILL.md'), 'utf8')).toBe('original');
});

describe('Briefback update check', () => {
    const tree = 'a'.repeat(40);
    const nextTree = 'b'.repeat(40);
    const commit = 'c'.repeat(40);

    test('compares the installed skill tree with upstream', async () => {
        const { roots, source } = setup();
        await installBriefback(roots, briefbackStatus(roots).fingerprint, { source, treeId: tree, commitId: commit });
        expect(
            await checkBriefbackUpdate(roots, briefbackStatus(roots).fingerprint, {
                upstream: async () => ({ tree, relationship: 'identical' }),
            })
        ).toBe('up-to-date');
        expect(
            await checkBriefbackUpdate(roots, briefbackStatus(roots).fingerprint, {
                upstream: async () => ({ tree: nextTree, relationship: 'ahead' }),
            })
        ).toBe('update-available');
    });

    test('reports unknown for an externally installed copy', async () => {
        const { roots, source } = setup();
        await installBriefback(roots, briefbackStatus(roots).fingerprint, { source });
        expect(
            await checkBriefbackUpdate(roots, briefbackStatus(roots).fingerprint, {
                upstream: async () => ({ tree: nextTree, relationship: 'ahead' }),
            })
        ).toBe('unknown');
    });

    test('reports unknown after a person edits a copy', async () => {
        const { roots, source } = setup();
        await installBriefback(roots, briefbackStatus(roots).fingerprint, { source, treeId: tree, commitId: commit });
        writeFileSync(join(roots[0]!, 'briefback', 'references', 'review.md'), 'Personal changes');
        expect(
            await checkBriefbackUpdate(roots, briefbackStatus(roots).fingerprint, {
                upstream: async () => ({ tree: nextTree, relationship: 'ahead' }),
            })
        ).toBe('unknown');
    });

    test('reports unknown when upstream cannot be checked', async () => {
        const { roots, source } = setup();
        await installBriefback(roots, briefbackStatus(roots).fingerprint, { source, treeId: tree, commitId: commit });
        expect(
            await checkBriefbackUpdate(roots, briefbackStatus(roots).fingerprint, {
                upstream: async () => {
                    throw new Error('offline');
                },
            })
        ).toBe('unknown');
    });

    test('reports unknown if a copy changes while upstream is checked', async () => {
        const { roots, source } = setup();
        await installBriefback(roots, briefbackStatus(roots).fingerprint, { source, treeId: tree, commitId: commit });
        const result = await checkBriefbackUpdate(roots, briefbackStatus(roots).fingerprint, {
            upstream: async () => {
                writeFileSync(join(roots[1]!, 'briefback', 'SKILL.md'), 'changed');
                return { tree: nextTree, relationship: 'ahead' };
            },
        });
        expect(result).toBe('unknown');
    });
    test('does not report an update when history diverged or went backwards', async () => {
        const { roots, source } = setup();
        await installBriefback(roots, briefbackStatus(roots).fingerprint, { source, treeId: tree, commitId: commit });
        const fingerprint = briefbackStatus(roots).fingerprint;
        expect(
            await checkBriefbackUpdate(roots, fingerprint, {
                upstream: async () => ({ tree: nextTree, relationship: 'diverged' }),
            })
        ).toBe('unknown');
        expect(
            await checkBriefbackUpdate(roots, fingerprint, {
                upstream: async () => ({ tree: nextTree, relationship: 'behind' }),
            })
        ).toBe('unknown');
    });

    test('does not report an update for a stale UI snapshot', async () => {
        const { roots, source } = setup();
        await installBriefback(roots, briefbackStatus(roots).fingerprint, { source, treeId: tree, commitId: commit });
        const fingerprint = briefbackStatus(roots).fingerprint;
        writeFileSync(join(roots[0]!, 'briefback', 'references', 'review.md'), 'changed');
        expect(
            await checkBriefbackUpdate(roots, fingerprint, {
                upstream: async () => ({ tree: nextTree, relationship: 'ahead' }),
            })
        ).toBe('unknown');
    });
    test('reads the upstream skill tree at the same commit whose ancestry was checked', async () => {
        const { roots, source } = setup();
        await installBriefback(roots, briefbackStatus(roots).fingerprint, { source, treeId: tree, commitId: commit });
        const head = 'd'.repeat(40);
        const urls: string[] = [];
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            urls.push(url);
            if (url.endsWith('/commits/main')) return Response.json({ sha: head });
            if (url.includes('/compare/'))
                return Response.json({
                    status: 'ahead',
                    base_commit: { sha: commit },
                    merge_base_commit: { sha: commit },
                });
            return Response.json([{ type: 'dir', path: 'skills/briefback', sha: nextTree }]);
        }) as typeof fetch;
        try {
            expect(await checkBriefbackUpdate(roots, briefbackStatus(roots).fingerprint)).toBe('update-available');
            expect(urls).toEqual([
                `https://api.github.com/repos/reforma-ai/briefback/commits/main`,
                `https://api.github.com/repos/reforma-ai/briefback/compare/${commit}...${head}`,
                `https://api.github.com/repos/reforma-ai/briefback/contents/skills?ref=${head}`,
            ]);
        } finally {
            globalThis.fetch = original;
        }
    });

    test('does not trust an inconsistent comparison response', async () => {
        const { roots, source } = setup();
        await installBriefback(roots, briefbackStatus(roots).fingerprint, { source, treeId: tree, commitId: commit });
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request) =>
            String(input).endsWith('/commits/main')
                ? Response.json({ sha: commit })
                : Response.json({
                      status: 'ahead',
                      base_commit: { sha: commit },
                      merge_base_commit: { sha: commit },
                  })) as typeof fetch;
        try {
            expect(await checkBriefbackUpdate(roots, briefbackStatus(roots).fingerprint)).toBe('unknown');
        } finally {
            globalThis.fetch = original;
        }
    });
});

describe('symlinked Briefback installations', () => {
    test('recognizes linked directories while leaving their update status unknown', async () => {
        const { roots, source } = setup();
        for (const root of roots) {
            mkdirSync(root, { recursive: true });
            symlinkSync(source, join(root, 'briefback'), 'dir');
        }
        const status = briefbackStatus(roots);
        expect(status.copies).toEqual([
            { exists: true, installed: true },
            { exists: true, installed: true },
        ]);
        expect(await checkBriefbackUpdate(roots, status.fingerprint)).toBe('unknown');
    });

    test('detects changes to a linked skill after confirmation', async () => {
        const { roots, source } = setup();
        mkdirSync(roots[0]!, { recursive: true });
        symlinkSync(source, join(roots[0]!, 'briefback'), 'dir');
        const status = briefbackStatus(roots);
        writeFileSync(join(source, 'references', 'review.md'), 'Changed');
        expect(briefbackStatus(roots).fingerprint).not.toBe(status.fingerprint);
        await expect(installBriefback(roots, status.fingerprint, { source })).rejects.toMatchObject({
            code: 'conflict',
        });
        expect(readFileSync(join(source, 'references', 'review.md'), 'utf8')).toBe('Changed');
    });

    test('detects a broken link becoming valid before installation', async () => {
        const { roots, source } = setup();
        const target = join(roots[0]!, 'missing');
        mkdirSync(roots[0]!, { recursive: true });
        symlinkSync(target, join(roots[0]!, 'briefback'), 'dir');
        const status = briefbackStatus(roots);
        expect(status.copies[0]).toEqual({ exists: true, installed: false });
        mkdirSync(target);
        writeFileSync(join(target, 'SKILL.md'), '---\nname: briefback\ndescription: A workflow\n---\n');
        expect(briefbackStatus(roots).copies[0]).toEqual({ exists: true, installed: true });
        await expect(installBriefback(roots, status.fingerprint, { source })).rejects.toMatchObject({
            code: 'conflict',
        });
        expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('A workflow');
    });

    test('replaces only the confirmed link and preserves its target', async () => {
        const { roots, source } = setup();
        const external = join(source, 'references', 'review.md');
        mkdirSync(roots[0]!, { recursive: true });
        symlinkSync(source, join(roots[0]!, 'briefback'), 'dir');
        const status = briefbackStatus(roots);
        await installBriefback(roots, status.fingerprint, { source });
        expect(briefbackStatus(roots).copies).toEqual([
            { exists: true, installed: true },
            { exists: true, installed: true },
        ]);
        expect(lstatSync(join(roots[0]!, 'briefback')).isSymbolicLink()).toBe(false);
        expect(readFileSync(external, 'utf8')).toBe('Review');
        expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toContain('A workflow');
    });
    test('restores a relative link after a later destination changes', async () => {
        const { roots, source } = setup();
        mkdirSync(roots[0]!, { recursive: true });
        symlinkSync('../../source', join(roots[0]!, 'briefback'), 'dir');
        const status = briefbackStatus(roots);
        await expect(
            installBriefback(roots, status.fingerprint, {
                source,
                onCopyInstalled(index) {
                    if (index === 0) mkdirSync(join(roots[1]!, 'briefback'));
                },
            })
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(readlinkSync(join(roots[0]!, 'briefback'))).toBe('../../source');
        expect(readFileSync(join(roots[0]!, 'briefback', 'references', 'review.md'), 'utf8')).toBe('Review');
        expect(readFileSync(join(source, 'references', 'review.md'), 'utf8')).toBe('Review');
    });

    test('does not replace a link retargeted after confirmation', async () => {
        const { roots, source } = setup();
        mkdirSync(roots[0]!, { recursive: true });
        const link = join(roots[0]!, 'briefback');
        symlinkSync(source, link, 'dir');
        const status = briefbackStatus(roots);
        unlinkSync(link);
        symlinkSync('../elsewhere', link, 'dir');
        await expect(installBriefback(roots, status.fingerprint, { source })).rejects.toMatchObject({
            code: 'conflict',
        });
        expect(readlinkSync(link)).toBe('../elsewhere');
        expect(readFileSync(join(source, 'references', 'review.md'), 'utf8')).toBe('Review');
    });

    test('can replace a broken link without touching its absent target', async () => {
        const { roots, source } = setup();
        mkdirSync(roots[0]!, { recursive: true });
        const link = join(roots[0]!, 'briefback');
        symlinkSync('../missing', link, 'dir');
        const status = briefbackStatus(roots);
        await installBriefback(roots, status.fingerprint, { source });
        expect(lstatSync(link).isDirectory()).toBe(true);
        expect(briefbackStatus(roots).copies).toEqual([
            { exists: true, installed: true },
            { exists: true, installed: true },
        ]);
        expect(() => lstatSync(join(roots[0]!, '..', 'missing'))).toThrow();
    });

    test('reports a cyclic link as present but not installed', () => {
        const { roots } = setup();
        mkdirSync(roots[0]!, { recursive: true });
        symlinkSync('briefback', join(roots[0]!, 'briefback'), 'dir');
        expect(briefbackStatus(roots).copies[0]).toEqual({ exists: true, installed: false });
    });
});
