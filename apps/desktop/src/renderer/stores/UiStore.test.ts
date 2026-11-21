import { describe, expect, it } from 'vitest';

import { initialUiFromSearch, UiStore } from './UiStore';

import type { KeyValueStorage } from './storage';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
    const data = { ...initial };

    return { data, getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value), removeItem: key => void delete data[key] };
}

describe('UiStore', () => {
    it('opens a section of a project from elsewhere: a task, a run, a chat, a document', () => {
        const ui = new UiStore().forProject('p1');

        ui.openTask('t1');
        expect([ui.section, ui.taskId]).toEqual(['tasks', 't1']);
        ui.openRun('r1');
        expect([ui.section, ui.runId]).toEqual(['agents', 'r1']);
        ui.openChat('c1');
        expect([ui.section, ui.chatId, ui.runId]).toEqual(['agents', 'c1', null]);
        ui.openDoc('decisions/pricing.md');
        expect([ui.section, ui.docPath]).toEqual(['docs', 'decisions/pricing.md']);
    });

    it('keeps the folder of the open document, the main one when none is named, across a restart', () => {
        const storage = memoryStorage();
        const ui = new UiStore(storage).forProject('p1');

        ui.openDoc('endpoints.md', 'fld_api');
        expect([ui.docPath, ui.docFolderId, ui.view.docFolderId]).toEqual(['endpoints.md', 'fld_api', 'fld_api']);
        expect(new UiStore(storage).forProject('p1')).toMatchObject({ docPath: 'endpoints.md', docFolderId: 'fld_api' });

        ui.openDoc('decisions/pricing.md');
        expect([ui.docPath, ui.docFolderId]).toEqual(['decisions/pricing.md', null]);
    });

    it('keeps a chat and one of its runs apart: opening one clears the other, and so does the new-chat row', () => {
        const ui = new UiStore().forProject('p1');

        ui.openChat('c1');
        ui.openRun('r1');
        expect([ui.chatId, ui.runId, ui.draft]).toEqual(['c1', 'r1', false]);

        ui.openDraft();
        expect([ui.section, ui.runId, ui.draft]).toEqual(['agents', null, true]);

        ui.openRun('r1');
        expect(ui.draft).toBe(false);

        ui.openDraft();
        ui.openChat('c2');
        expect([ui.chatId, ui.runId, ui.draft]).toEqual(['c2', null, false]);
    });

    it('holds the files a hand-off gives the new-chat page until the page takes them, once, and does not keep them', () => {
        const storage = memoryStorage();
        const ui = new UiStore(storage).forProject('p1');
        const file = new File(['conversation'], 'chat-conversation.md');

        ui.openDraft();
        expect(ui.pendingFiles).toEqual([]);

        ui.openChat('c1');
        ui.openDraft([file]);
        expect([ui.draft, ui.pendingFiles]).toEqual([true, [file]]);
        expect(JSON.stringify(storage.data)).not.toContain('chat-conversation');

        expect(ui.takePendingFiles()).toEqual([file]);
        expect(ui.takePendingFiles()).toEqual([]);
        expect(ui.pendingFiles).toEqual([]);
    });

    it('does not keep the new-chat row between sessions, but shows it again with back and forward', () => {
        const storage = memoryStorage();
        const first = new UiStore(storage).forProject('p1');

        first.openDraft();

        expect(new UiStore(storage).forProject('p1').draft).toBe(false);

        const view = first.view;

        first.openChat('c1');
        first.show(view);

        expect(first.draft).toBe(true);
    });

    it('remembers each project on its own and restores it in a new window', () => {
        const storage = memoryStorage();
        const first = new UiStore(storage);

        first.forProject('p1').openTask('t7');
        first.forProject('p1').setTasksView('list');
        first.forProject('p2').openChat('c3');

        const second = new UiStore(storage);

        expect(second.forProject('p1')).toMatchObject({ section: 'tasks', taskId: 't7', tasksView: 'list' });
        expect(second.forProject('p2')).toMatchObject({ section: 'agents', chatId: 'c3', tasksView: 'board' });
        expect(second.forProject('p3').section).toBe('agents');
    });

    it('starts from defaults when the stored value is damaged', () => {
        const ui = new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"section":"nope","taskId":5,"tasksView":"cards"}' })).forProject('p1');

        expect(ui).toMatchObject({ section: 'agents', taskId: null, tasksView: 'board' });
        expect(new UiStore(memoryStorage({ 'clowdy:ui:p1': 'not json' })).forProject('p1').section).toBe('agents');
    });

    it('keeps working when storage throws', () => {
        const broken: KeyValueStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };
        const ui = new UiStore(broken).forProject('p1');

        expect(() => ui.openTask('t1')).not.toThrow();
        expect(ui.taskId).toBe('t1');
    });

    it('leaves Settings when a section is chosen', () => {
        const store = new UiStore();
        const ui = store.forProject('p1');

        store.openSettings();
        expect(store.settingsOpen).toBe(true);
        store.showSection(ui, 'docs');
        expect([store.settingsOpen, ui.section]).toEqual([false, 'docs']);
    });

    it('keeps the Settings page it was left on, and opens on another when asked', () => {
        const store = new UiStore();

        store.openSettings();
        expect(store.settingsPage).toBe('appearance');
        store.showSettingsPage('skills');
        store.openSettings();
        expect(store.settingsPage).toBe('skills');
        store.openSettings('providers');
        expect([store.settingsOpen, store.settingsPage]).toEqual([true, 'providers']);
    });

    it('shows the Agents section for a section an older version stored under the name Chats', () => {
        const ui = new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"section":"chats","chatId":"c-1"}' })).forProject('p1');

        expect(ui).toMatchObject({ section: 'agents', chatId: 'c-1' });
    });

    it('starts from what the page URL preselects, ahead of the stored state', () => {
        const initial = initialUiFromSearch('?fixtures=1&section=tasks&task=t-24&view=list&chat=c-1&run=r-1&doc=a.md&docFolder=fld-2');
        const ui = new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"section":"docs","tasksView":"board"}' }), initial).forProject('p1');

        expect(ui).toMatchObject({ section: 'tasks', taskId: 't-24', tasksView: 'list', chatId: 'c-1', runId: 'r-1', docPath: 'a.md', docFolderId: 'fld-2' });
    });

    it('folds every chat until its threads are opened, and keeps what the person opened per project across a restart', () => {
        const storage = memoryStorage();
        const store = new UiStore(storage);
        const ui = store.forProject('p1');

        expect(ui.expandedChats).toEqual([]);

        ui.toggleChatExpanded('c-1');
        ui.toggleChatExpanded('c-2');
        ui.toggleChatExpanded('c-1');
        expect(ui.expandedChats).toEqual(['c-2']);
        expect(store.forProject('p2').expandedChats).toEqual([]);

        expect(new UiStore(storage).forProject('p1').expandedChats).toEqual(['c-2']);
    });

    it('opens the folds above a chat without closing any, and changes nothing when they are open', () => {
        const ui = new UiStore().forProject('p1');

        ui.toggleChatExpanded('a');
        ui.expandChats(['b', 'a']);
        expect(ui.expandedChats).toEqual(['a', 'b']);

        const before = ui.expandedChats;

        ui.expandChats(['a', 'b']);
        expect(ui.expandedChats).toBe(before);
    });

    it('reads the folds of threads from the page URL, and drops what is damaged in storage', () => {
        expect(initialUiFromSearch('?expand=c-6,c-6a')).toEqual({ expandedChats: ['c-6', 'c-6a'] });
        expect(new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"expandedChats":"c-1"}' })).forProject('p1')).toMatchObject({ expandedChats: [] });
        expect(new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"expandedChats":["c-1",5]}' })).forProject('p1').expandedChats).toEqual(['c-1']);
    });

    it('shows the rows of the running-agents strip until the person folds them, and remembers it per project', () => {
        const storage = memoryStorage();
        const store = new UiStore(storage);
        const ui = store.forProject('p1');

        expect(ui.agentsFolded).toBe(false);

        ui.toggleAgentsFolded();
        expect(ui.agentsFolded).toBe(true);
        expect(store.forProject('p2').agentsFolded).toBe(false);
        expect(new UiStore(storage).forProject('p1').agentsFolded).toBe(true);

        ui.toggleAgentsFolded();
        expect(new UiStore(storage).forProject('p1').agentsFolded).toBe(false);
    });

    it('reads the fold of the strip from the page URL, and drops what is damaged in storage', () => {
        expect(initialUiFromSearch('?agents=folded')).toEqual({ agentsFolded: true });
        expect(initialUiFromSearch('?agents=open')).toEqual({ agentsFolded: false });
        expect(new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"agentsFolded":"yes"}' })).forProject('p1').agentsFolded).toBe(false);
    });

    it('ignores URL values that name no section or view', () => {
        expect(initialUiFromSearch('?section=nope&view=cards')).toEqual({});
        expect(initialUiFromSearch('')).toEqual({});
    });

    it('opens Settings on the list of projects or on the page of one, and shows the list again when a page is chosen', () => {
        const ui = new UiStore();

        ui.openProjectSettings('p1');
        expect([ui.settingsOpen, ui.settingsPage, ui.settingsProjectId]).toEqual([true, 'projects', 'p1']);

        ui.openProjectSettings();
        expect(ui.settingsProjectId).toBeNull();

        ui.openProjectSettings('p1');
        ui.showSettingsPage('skills');
        ui.showSettingsPage('projects');
        expect(ui.settingsProjectId).toBeNull();
    });

    it('forgets a removed project: its window state, its stored copy, and its page in Settings', () => {
        const storage = memoryStorage({ 'clowdy:ui:p1': JSON.stringify({ section: 'tasks' }) });
        const ui = new UiStore(storage as KeyValueStorage);

        expect(ui.forProject('p1').section).toBe('tasks');
        ui.openProjectSettings('p1');
        ui.forgetProject('p1');

        expect(ui.settingsProjectId).toBeNull();
        expect(storage.data['clowdy:ui:p1']).toBeUndefined();
        expect(ui.forProject('p1').section).toBe('agents');
    });
});
