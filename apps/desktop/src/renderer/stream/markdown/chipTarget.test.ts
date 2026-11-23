import { describe, expect, it } from 'vitest';

import { resolveChipTarget } from './chipTarget';

import type { Place } from '../../features/sidePanel/currentPlace';

const WEB = { id: 'f-web', path: '/Users/dev/web' };
const API = { id: 'f-api', path: '/Users/dev/api' };
const FOLDERS = [WEB, API];

const resolve = (path: string, kind: 'file' | 'directory' = 'file', current: Place = { folder: WEB }) =>
    resolveChipTarget({ path, kind }, 'p-1', FOLDERS, current);

describe('what a chip points at', () => {
    it('reads a relative path against the folder of the open chat', () => {
        expect(resolve('src/index.ts')).toEqual({
            projectId: 'p-1',
            folder: WEB,
            path: '/Users/dev/web/src/index.ts',
            relative: 'src/index.ts',
            kind: 'file',
        });
        expect(resolve('src/index.ts', 'file', { folder: API })).toMatchObject({
            folder: API,
            path: '/Users/dev/api/src/index.ts',
        });
    });

    it('settles `.` and `..` inside the folder, and has nothing for a path that climbs out of it', () => {
        expect(resolve('src/../lib/./a.ts')).toMatchObject({ relative: 'lib/a.ts' });
        expect(resolve('../api/a.ts')).toBeUndefined();
        expect(resolve('a/../../b')).toBeUndefined();
    });

    it('finds the folder of the project that holds an absolute path, whichever chat is open', () => {
        expect(resolve('/Users/dev/api/src/a.ts')).toEqual({
            projectId: 'p-1',
            folder: API,
            path: '/Users/dev/api/src/a.ts',
            relative: 'src/a.ts',
            kind: 'file',
        });
        expect(resolve('/Users/dev/web/README.md', 'file', { folder: API })).toMatchObject({
            folder: WEB,
            relative: 'README.md',
        });
    });

    it('is a folder for the project folder itself, whatever it was written as', () => {
        expect(resolve('', 'directory')).toMatchObject({
            folder: WEB,
            path: '/Users/dev/web',
            relative: '',
            kind: 'directory',
        });
        expect(resolve('/Users/dev/api', 'file')).toMatchObject({ folder: API, relative: '', kind: 'directory' });
    });

    it('has nothing for an absolute path outside every folder of the project, or in a folder whose name only starts the same', () => {
        expect(resolve('/Users/dev/elsewhere/a.ts')).toBeUndefined();
        expect(resolve('/Users/dev/web-old/a.ts')).toBeUndefined();
        expect(resolve('/Users/dev/web/../secret/a.ts')).toBeUndefined();
    });

    it('reads a Windows path, written with forward slashes by the chip, against a folder written with backslashes', () => {
        const folder = { id: 'f-win', path: 'C:\\Users\\dev\\web' };

        expect(
            resolveChipTarget({ path: 'C:/Users/dev/web/src/a.ts', kind: 'file' }, 'p-1', [folder], { folder })
        ).toMatchObject({ folder, path: 'C:\\Users\\dev\\web\\src\\a.ts', relative: 'src/a.ts' });
    });
});

describe("what a chip points at in a chat's worktree", () => {
    const WORKTREE = {
        id: 'wks_1',
        folderId: 'f-web',
        path: '/Users/dev/Clowdy/workspaces/shop/ab12cd34/web',
        managed: true,
        ready: true,
    };
    const place: Place = { folder: WEB, workspace: WORKTREE };

    it('reads a relative path against the worktree', () => {
        expect(resolve('src/index.ts', 'file', place)).toEqual({
            projectId: 'p-1',
            folder: WEB,
            workspace: WORKTREE,
            path: '/Users/dev/Clowdy/workspaces/shop/ab12cd34/web/src/index.ts',
            relative: 'src/index.ts',
            kind: 'file',
        });
    });

    it('finds an absolute path under the worktree, which is under no folder of the project, in the worktree', () => {
        expect(resolve('/Users/dev/Clowdy/workspaces/shop/ab12cd34/web/src/a.ts', 'file', place)).toMatchObject({
            folder: WEB,
            workspace: WORKTREE,
            relative: 'src/a.ts',
            path: '/Users/dev/Clowdy/workspaces/shop/ab12cd34/web/src/a.ts',
        });
        expect(resolve('/Users/dev/Clowdy/workspaces/shop/ab12cd34/web', 'file', place)).toMatchObject({
            workspace: WORKTREE,
            relative: '',
            kind: 'directory',
        });
    });

    it("finds a path of the folder's own checkout in the checkout, not in the worktree, and one of another folder in that folder", () => {
        const checkout = resolve('/Users/dev/web/src/a.ts', 'file', place);

        expect(checkout).toMatchObject({ folder: WEB, relative: 'src/a.ts', path: '/Users/dev/web/src/a.ts' });
        expect(checkout?.workspace).toBeUndefined();
        expect(resolve('/Users/dev/api/src/a.ts', 'file', place)).toMatchObject({ folder: API });
        expect(resolve('/Users/dev/api/src/a.ts', 'file', place)?.workspace).toBeUndefined();
    });

    it("has nothing for another chat's worktree, a path that climbs out of the worktree, or a sibling folder that only starts with its name", () => {
        expect(resolve('/Users/dev/Clowdy/workspaces/shop/ff00ee11/web/src/a.ts', 'file', place)).toBeUndefined();
        expect(resolve('/Users/dev/Clowdy/workspaces/shop/ab12cd34/web/../../x', 'file', place)).toBeUndefined();
        expect(resolve('/Users/dev/Clowdy/workspaces/shop/ab12cd34/web2/a.ts', 'file', place)).toBeUndefined();
    });

    it('reads a Windows worktree written with forward slashes by the chip', () => {
        const windows = { ...WORKTREE, path: 'C:\\Users\\dev\\Clowdy\\workspaces\\shop\\ab12cd34\\web' };

        expect(
            resolve('C:/Users/dev/Clowdy/workspaces/shop/ab12cd34/web/src/a.ts', 'file', {
                folder: WEB,
                workspace: windows,
            })
        ).toMatchObject({
            workspace: windows,
            relative: 'src/a.ts',
            path: 'C:\\Users\\dev\\Clowdy\\workspaces\\shop\\ab12cd34\\web\\src\\a.ts',
        });
    });
});
