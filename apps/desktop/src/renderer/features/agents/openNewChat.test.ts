import { describe, expect, it } from 'vitest';

import { UiStore } from '../../stores/UiStore';
import { openNewChat } from './openNewChat';

import type { ProjectState } from '../../stores/ProjectState';

describe('folder new chat', () => {
    it('opens the folder checkout while preserving the worktree draft', () => {
        const ui = new UiStore().forProject('p');
        const project = { project: { folders: [{ id: 'main', path: '/project' }] } } as ProjectState;
        ui.openDraft([], null, { mode: 'existing', path: '/worktree' });
        const worktreeDraft = ui.draftId;

        openNewChat(project, ui, 'main');

        expect(ui.draftWorkspace).toBeNull();
        expect(ui.draftId).not.toBe(worktreeDraft);
        expect(ui.newChatDrafts.get(worktreeDraft!)?.workspace).toEqual({ mode: 'existing', path: '/worktree' });

        const checkoutDraft = ui.draftId;
        openNewChat(project, ui, 'main');
        expect(ui.draftId).toBe(checkoutDraft);
    });
});
