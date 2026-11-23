import { describe, expect, it } from 'vitest';

import { chatPlace, currentPlace, isPlaceReady, isSamePlace, placeKey, placeOf, placePath } from './currentPlace';

import type { Chat, ChatWorkspace, ChatWorkspaceChoice, ProjectFolder } from '@clowdy/protocol';

const folders: ProjectFolder[] = [
    { id: 'f1', path: '/Users/dev/web' },
    { id: 'f2', path: '/Users/dev/api' },
];
const workspace = (overrides: Partial<ChatWorkspace> = {}): ChatWorkspace => ({
    id: 'wks_1',
    folderId: 'f2',
    path: '/Users/dev/Clowdy/workspaces/shop/ab12cd34/api',
    branch: 'clowdy/ab12cd34',
    managed: true,
    ready: true,
    ...overrides,
});
const chats = new Map<string, Chat>([
    ['c1', { id: 'c1', folderId: 'f2' } as Chat],
    ['c2', { id: 'c2' } as Chat],
    ['c3', { id: 'c3', folderId: 'f2', workspace: workspace() } as Chat],
    ['c4', { id: 'c4', folderId: 'f2', workspace: workspace({ ready: false }) } as Chat],
    // A thread works where the chat it is below does, in its worktree: the daemon gives it the parent's workspace and folder.
    ['c5', { id: 'c5', folderId: 'f2', parentChatId: 'c3', workspace: workspace() } as Chat],
    // A stale read: the worktree is a checkout of another folder than the chat's.
    ['c6', { id: 'c6', folderId: 'f1', workspace: workspace() } as Chat],
]);
const project = { chats, project: { folders } as never };
const idle = {
    section: 'agents',
    chatId: null,
    draft: false,
    draftFolderId: null,
    draftWorkspace: null,
    draftWorkspaceRow: null,
} as const;

describe('the place the window works in', () => {
    it('is the folder of the open chat, and the main one for a chat that has none', () => {
        expect(currentPlace(project, { ...idle, chatId: 'c1' }).folder.path).toBe('/Users/dev/api');
        expect(currentPlace(project, { ...idle, chatId: 'c2' }).folder.path).toBe('/Users/dev/web');
    });

    it("has no worktree for a chat in the folder's own checkout", () => {
        expect(currentPlace(project, { ...idle, chatId: 'c1' }).workspace).toBeUndefined();
    });

    it('is the folder and the worktree of the open chat when it works in one, and of a thread below it', () => {
        expect(currentPlace(project, { ...idle, chatId: 'c3' })).toEqual({
            folder: folders[1],
            workspace: workspace(),
        });
        expect(currentPlace(project, { ...idle, chatId: 'c5' })).toEqual({
            folder: folders[1],
            workspace: workspace(),
        });
    });

    it('names the worktree of a chat that it is not made for yet, which the tabs answer with their empty state', () => {
        const place = currentPlace(project, { ...idle, chatId: 'c4' });

        expect(place.workspace?.id).toBe('wks_1');
        expect(isPlaceReady(place)).toBe(false);
    });

    it("leaves out a worktree that is not a checkout of the chat's folder", () => {
        expect(currentPlace(project, { ...idle, chatId: 'c6' })).toEqual({ folder: folders[0] });
    });

    it('is the folder of the new chat that is being made, with no worktree', () => {
        expect(currentPlace(project, { ...idle, draft: true, draftFolderId: 'f2' })).toEqual({ folder: folders[1] });
        expect(currentPlace(project, { ...idle, draft: true }).folder.path).toBe('/Users/dev/web');
    });

    // The new-chat page is opened over the chat that was open, which stays remembered under it, so the page's folder is what counts, and none of the chat's worktree.
    it('is the folder of the new chat that is being made, not that of the chat that was open when it was started, nor its worktree', () => {
        expect(currentPlace(project, { ...idle, chatId: 'c1', draft: true }).folder.path).toBe('/Users/dev/web');
        expect(currentPlace(project, { ...idle, chatId: 'c2', draft: true, draftFolderId: 'f2' }).folder.path).toBe(
            '/Users/dev/api'
        );
        expect(currentPlace(project, { ...idle, chatId: 'c3', draft: true, draftFolderId: 'f2' })).toEqual({
            folder: folders[1],
        });
    });

    describe('of a new chat that chose a worktree that exists', () => {
        const row = workspace({ id: 'wks_found', managed: false, path: '/Users/dev/api-feature', branch: 'feature' });
        const choice: ChatWorkspaceChoice = { mode: 'existing', path: '/Users/dev/api-feature' };
        const draft = { ...idle, draft: true, draftFolderId: 'f2', draftWorkspace: choice, draftWorkspaceRow: row };

        it('is that worktree once the daemon has answered for it, and it is ready as the worktree is', () => {
            const place = currentPlace(project, draft);

            expect(place).toEqual({ folder: folders[1], workspace: row });
            expect(isPlaceReady(place)).toBe(true);
            expect(placeKey(place)).toBe('wks_found');
        });

        it('is the same place the chat that is made from it has, so nothing changes under the tabs when the first message goes', () => {
            const made = new Map(chats).set('c7', { id: 'c7', folderId: 'f2', workspace: row } as Chat);

            expect(
                isSamePlace(
                    currentPlace(project, draft),
                    currentPlace({ ...project, chats: made }, { ...idle, chatId: 'c7' })
                )
            ).toBe(true);
        });

        it("is the folder's own checkout until the answer comes, and for a worktree the page has not chosen yet", () => {
            expect(currentPlace(project, { ...draft, draftWorkspaceRow: null })).toEqual({ folder: folders[1] });
            expect(currentPlace(project, { ...draft, draftWorkspace: null })).toEqual({ folder: folders[1] });
        });

        it("is the folder's own checkout when the row is not for what the page chose: another worktree, another folder, or a new worktree", () => {
            expect(
                currentPlace(project, { ...draft, draftWorkspace: { mode: 'existing', path: '/Users/dev/api-other' } })
            ).toEqual({ folder: folders[1] });
            expect(currentPlace(project, { ...draft, draftFolderId: null })).toEqual({ folder: folders[0] });
            expect(currentPlace(project, { ...draft, draftWorkspace: { mode: 'new' } })).toEqual({
                folder: folders[1],
            });
        });

        it('takes a path the daemon wrote with a trailing separator for the same worktree', () => {
            expect(
                currentPlace(project, {
                    ...draft,
                    draftWorkspace: { mode: 'existing', path: '/Users/dev/api-feature/' },
                }).workspace
            ).toEqual(row);
        });

        it("is not the chat's worktree when the page is left for the chat: the chat's own place counts", () => {
            expect(currentPlace(project, { ...draft, draft: false, chatId: 'c1' })).toEqual({ folder: folders[1] });
        });
    });

    it('is the main folder when no chat is open, and when the open chat is not there', () => {
        expect(currentPlace(project, idle).folder.path).toBe('/Users/dev/web');
        expect(currentPlace(project, { ...idle, chatId: 'gone' }).folder.path).toBe('/Users/dev/web');
    });

    it('is the place of a chat by its own folder and worktree, for a chat the window does not have open', () => {
        expect(chatPlace(folders, { folderId: 'f2', workspace: workspace() })).toEqual({
            folder: folders[1],
            workspace: workspace(),
        });
        expect(chatPlace(folders, {})).toEqual({ folder: folders[0] });
        expect(chatPlace(folders, { folderId: 'f1', workspace: workspace() })).toEqual({ folder: folders[0] });
        expect(chatPlace(folders, { folderId: 'f-gone' })).toEqual({ folder: folders[0] });
    });
});

describe('what a place is kept under', () => {
    const own = { folder: folders[1] };
    const worktree = { folder: folders[1], workspace: workspace() };

    it("is the worktree's id for a worktree and the folder's for its own checkout, so the two never share tabs, trees or shells", () => {
        expect(placeKey(own)).toBe('f2');
        expect(placeKey(worktree)).toBe('wks_1');
    });

    it('is the same for two chats that share a worktree, and different for two worktrees of one folder', () => {
        expect(placeKey({ folder: folders[1], workspace: workspace() })).toBe(placeKey(worktree));
        expect(placeKey({ folder: folders[1], workspace: workspace({ id: 'wks_2' }) })).not.toBe(placeKey(worktree));
        expect(isSamePlace(worktree, { folder: folders[1], workspace: workspace() })).toBe(true);
        expect(isSamePlace(worktree, own)).toBe(false);
        expect(isSamePlace(own, { folder: folders[0] })).toBe(false);
    });

    it("is cut out of something that has more, such as a menu's target, without a worktree key when there is none", () => {
        expect(placeOf({ ...worktree, path: '/x', relative: '' } as typeof worktree)).toEqual(worktree);
        expect(Object.keys(placeOf({ ...own, workspace: undefined }))).toEqual(['folder']);
    });

    it("is on the disk at the worktree's path, else at the folder's", () => {
        expect(placePath(own)).toBe('/Users/dev/api');
        expect(placePath(worktree)).toBe('/Users/dev/Clowdy/workspaces/shop/ab12cd34/api');
    });

    it("is ready for a folder's own checkout and for a worktree that is made", () => {
        expect(isPlaceReady(own)).toBe(true);
        expect(isPlaceReady(worktree)).toBe(true);
        expect(isPlaceReady({ folder: folders[1], workspace: workspace({ ready: false }) })).toBe(false);
    });
});
