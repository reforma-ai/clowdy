// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mentionedFiles, pasteFiles } from './pastedFiles';

import type { ProjectFolder } from '@clowdy/protocol';
import type { ClipboardFile, DesktopBridge } from '../../../shared/bridge';

const folders = [
    { id: 'f1', path: '/Users/dev/web' },
    { id: 'f2', path: '/Users/dev/api' },
] as ProjectFolder[];

const file = (path: string, kind: ClipboardFile['kind'] = 'file'): ClipboardFile => ({
    path,
    name: path.split('/').pop()!,
    kind,
});

describe('the chips for the files on the clipboard', () => {
    it('cite a file of the main folder from that folder, and a file of another folder by its absolute path', () => {
        expect(
            mentionedFiles(
                [
                    file('/Users/dev/web/src/a.ts'),
                    file('/Users/dev/api/src/b.ts'),
                    file('/Users/dev/web/docs', 'directory'),
                ],
                folders
            )
        ).toEqual([
            { id: 'file:f1:src/a.ts', label: 'a.ts', kind: 'file', trigger: '@', data: { path: 'src/a.ts' } },
            {
                id: 'file:f2:src/b.ts',
                label: 'b.ts',
                kind: 'file',
                trigger: '@',
                data: { path: '/Users/dev/api/src/b.ts' },
            },
            { id: 'file:f1:docs', label: 'docs', kind: 'file', trigger: '@', data: { path: 'docs', directory: true } },
        ]);
    });

    it('cite a file of the folder the chat works in from there, and one of the main folder by its absolute path', () => {
        expect(
            mentionedFiles([file('/Users/dev/api/src/b.ts'), file('/Users/dev/web/src/a.ts')], folders, {
                folder: folders[1]!,
            })
        ).toEqual([
            { id: 'file:f2:src/b.ts', label: 'b.ts', kind: 'file', trigger: '@', data: { path: 'src/b.ts' } },
            {
                id: 'file:f1:src/a.ts',
                label: 'a.ts',
                kind: 'file',
                trigger: '@',
                data: { path: '/Users/dev/web/src/a.ts' },
            },
        ]);
    });

    it("cite a file of the chat's worktree, which is under no folder of the project, from the worktree, and leave out one of another worktree", () => {
        const place = {
            folder: folders[0]!,
            workspace: {
                id: 'wks_1',
                folderId: 'f1',
                path: '/Users/dev/Clowdy/workspaces/shop/ab12cd34/web',
                managed: true,
                ready: true,
            },
        };

        expect(
            mentionedFiles(
                [
                    file('/Users/dev/Clowdy/workspaces/shop/ab12cd34/web/src/a.ts'),
                    file('/Users/dev/Clowdy/workspaces/shop/ab12cd34/web/docs', 'directory'),
                    // The folder's own checkout is another place: an absolute path.
                    file('/Users/dev/web/src/c.ts'),
                    file('/Users/dev/Clowdy/workspaces/shop/ff00ee11/web/src/d.ts'),
                ],
                folders,
                place
            )
        ).toEqual([
            { id: 'file:f1:src/a.ts', label: 'a.ts', kind: 'file', trigger: '@', data: { path: 'src/a.ts' } },
            { id: 'file:f1:docs', label: 'docs', kind: 'file', trigger: '@', data: { path: 'docs', directory: true } },
            {
                id: 'file:f1:src/c.ts',
                label: 'c.ts',
                kind: 'file',
                trigger: '@',
                data: { path: '/Users/dev/web/src/c.ts' },
            },
        ]);
    });

    it('leave out what is outside the project, and a folder itself', () => {
        expect(
            mentionedFiles(
                [
                    file('/Users/dev/Downloads/report.pdf'),
                    file('/Users/dev/website/a.ts'),
                    file('/Users/dev/web', 'directory'),
                ],
                folders
            )
        ).toEqual([]);
    });
});

describe('files pasted into the message box', () => {
    afterEach(() => {
        delete window.desktop;
    });

    const targets = () => ({ folders, mention: vi.fn(), attach: vi.fn() });
    const clipboard = (...held: ClipboardFile[]) => {
        window.desktop = { platform: 'darwin', readClipboardFiles: async () => held } as unknown as DesktopBridge;
    };

    it('become chips when they are in the project, and are not attached', async () => {
        const { mention, attach, ...rest } = targets();
        const pasted = new File(['a'], 'a.ts');

        clipboard(file('/Users/dev/web/src/a.ts'));
        await pasteFiles([pasted], { mention, attach, ...rest });

        expect(mention).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'file:f1:src/a.ts', data: { path: 'src/a.ts' } })
        );
        expect(attach).not.toHaveBeenCalled();
    });

    it('are attached when they are somewhere else, and only the ones in the project become chips', async () => {
        const { mention, attach, ...rest } = targets();
        const inside = new File(['a'], 'a.ts');
        const outside = new File(['r'], 'report.pdf');

        clipboard(file('/Users/dev/web/a.ts'), file('/Users/dev/Downloads/report.pdf'));
        await pasteFiles([inside, outside], { mention, attach, ...rest });

        expect(mention).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledWith([outside]);
    });

    it("leave a file of the same name from outside the project to be attached, and take a folder's trailing separator for the folder", async () => {
        const { mention, attach, ...rest } = targets();
        const inside = new File(['a'], 'README.md');
        const outside = new File(['b'], 'README.md');

        clipboard(
            file('/Users/dev/web/README.md'),
            file('/Users/dev/Downloads/README.md'),
            file('/Users/dev/web/', 'directory')
        );
        await pasteFiles([inside, outside], { mention, attach, ...rest });

        expect(mention).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledWith([outside]);
    });

    it('are attached as the browser gave them in a page that is not the desktop app, and when the clipboard cannot be read', async () => {
        const { mention, attach, ...rest } = targets();
        const pasted = new File(['a'], 'a.ts');

        await pasteFiles([pasted], { mention, attach, ...rest });

        window.desktop = {
            platform: 'darwin',
            readClipboardFiles: async () => Promise.reject(new Error('no')),
        } as unknown as DesktopBridge;
        await pasteFiles([pasted], { mention, attach, ...rest });

        expect(attach).toHaveBeenCalledTimes(2);
        expect(attach).toHaveBeenCalledWith([pasted]);
        expect(mention).not.toHaveBeenCalled();
    });
});
