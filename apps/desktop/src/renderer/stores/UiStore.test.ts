import { describe, expect, it } from 'vitest';

import { initialUiFromSearch, UiStore } from './UiStore';

import type { KeyValueStorage } from './storage';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
    const data = { ...initial };

    return { data, getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

describe('UiStore', () => {
    it('opens a section of a project from elsewhere: a task, a run, a chat, a document', () => {
        const ui = new UiStore().forProject('p1');

        ui.openTask('t1');
        expect([ui.section, ui.taskId]).toEqual(['tasks', 't1']);
        ui.openRun('r1');
        expect([ui.section, ui.runId]).toEqual(['agents', 'r1']);
        ui.openChat('c1');
        expect([ui.section, ui.chatId]).toEqual(['chats', 'c1']);
        ui.openDoc('decisions/pricing.md');
        expect([ui.section, ui.docPath]).toEqual(['docs', 'decisions/pricing.md']);
    });

    it('remembers each project on its own and restores it in a new window', () => {
        const storage = memoryStorage();
        const first = new UiStore(storage);

        first.forProject('p1').openTask('t7');
        first.forProject('p1').setTasksView('list');
        first.forProject('p1').setShowFinished(true);
        first.forProject('p2').openChat('c3');

        const second = new UiStore(storage);

        expect(second.forProject('p1')).toMatchObject({ section: 'tasks', taskId: 't7', tasksView: 'list', showFinished: true });
        expect(second.forProject('p2')).toMatchObject({ section: 'chats', chatId: 'c3', tasksView: 'board', showFinished: false });
        expect(second.forProject('p3').section).toBe('chats');
    });

    it('starts from defaults when the stored value is damaged', () => {
        const ui = new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"section":"nope","taskId":5,"tasksView":"cards"}' })).forProject('p1');

        expect(ui).toMatchObject({ section: 'chats', taskId: null, tasksView: 'board' });
        expect(new UiStore(memoryStorage({ 'clowdy:ui:p1': 'not json' })).forProject('p1').section).toBe('chats');
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

    it('starts from what the page URL preselects, ahead of the stored state', () => {
        const initial = initialUiFromSearch('?fixtures=1&section=tasks&task=t-24&view=list&finished=1&chat=c-1&run=r-1&doc=a.md');
        const ui = new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"section":"docs","tasksView":"board"}' }), initial).forProject('p1');

        expect(ui).toMatchObject({ section: 'tasks', taskId: 't-24', tasksView: 'list', showFinished: true, chatId: 'c-1', runId: 'r-1', docPath: 'a.md' });
    });

    it('ignores URL values that name no section or view', () => {
        expect(initialUiFromSearch('?section=nope&view=cards')).toEqual({});
        expect(initialUiFromSearch('')).toEqual({});
    });
});
