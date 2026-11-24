import { describe, expect, it } from 'vitest';

import { COLLAPSED_TASKS_LIMIT, COMMENT_DRAFTS_LIMIT, initialUiFromSearch, UiStore } from './UiStore';

import type { KeyValueStorage } from './storage';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
    const data = { ...initial };

    return {
        data,
        getItem: key => data[key] ?? null,
        setItem: (key, value) => void (data[key] = value),
        removeItem: key => void delete data[key],
    };
}

describe('UiStore', () => {
    it('opens a place of a project from elsewhere: a task (in the side panel), a run, a chat', () => {
        const ui = new UiStore().forProject('p1');

        ui.openTask('t1');
        expect([ui.taskId, ui.sidePanelOpen, ui.sidePanelTab]).toEqual(['t1', true, 'tasks']);
        ui.openTask(null);
        expect([ui.taskId, ui.sidePanelOpen, ui.sidePanelTab]).toEqual([null, true, 'tasks']);
        ui.openRun('r1');
        expect([ui.runId]).toEqual(['r1']);
        ui.openChat('c1');
        expect([ui.chatId, ui.runId]).toEqual(['c1', null]);
    });

    it('forgets what an older version kept of the open document, and the Docs section', () => {
        const storage = memoryStorage({
            'clowdy:ui:p1': '{"section":"docs","docPath":"decisions/pricing.md","docFolderId":"fld_api"}',
        });
        const ui = new UiStore(storage).forProject('p1');
        expect(ui).not.toHaveProperty('docPath');
        expect(Object.keys(ui.view)).not.toContain('docPath');
    });

    it('keeps a chat and one of its runs apart: opening one clears the other, and so does the new-chat row', () => {
        const ui = new UiStore().forProject('p1');

        ui.openChat('c1');
        ui.openRun('r1');
        expect([ui.chatId, ui.runId, ui.draft]).toEqual(['c1', 'r1', false]);

        ui.openDraft();
        expect([ui.runId, ui.draft]).toEqual([null, true]);

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

        expect(second.forProject('p1')).toMatchObject({
            taskId: 't7',
            tasksView: 'list',
            sidePanelOpen: true,
            sidePanelTab: 'tasks',
        });
        expect(second.forProject('p2')).toMatchObject({ chatId: 'c3', tasksView: 'board' });
        expect(second.forProject('p3').chatId).toBeNull();
    });

    describe('the scope of the Tasks screen and its options', () => {
        const held = (...ids: string[]) => new Map(ids.map(id => [id, {} as { archivedAt?: number }]));

        it("starts at the roots, with the sub-tasks hidden, the board on a task's page and nothing folded", () => {
            const ui = new UiStore().forProject('p1');

            expect([ui.tasksScope, ui.tasksSubtasks, ui.taskPageView, ui.tasksCollapsed]).toEqual([
                null,
                false,
                'board',
                [],
            ]);
        });

        it('keeps the scope, the sub-tasks toggle, the task page view and the folds per project across a restart', () => {
            const storage = memoryStorage();
            const first = new UiStore(storage);

            first.forProject('p1').setTasksScope('t-31');
            first.forProject('p1').setTasksSubtasks(true);
            first.forProject('p1').setTaskPageView('list');
            first.forProject('p1').toggleTaskCollapsed('t-32');
            first.forProject('p1').toggleTaskCollapsed('t-35');
            first.forProject('p2').setTasksScope('t-9');

            const second = new UiStore(storage);

            expect(second.forProject('p1')).toMatchObject({
                tasksScope: 't-31',
                tasksSubtasks: true,
                taskPageView: 'list',
                tasksCollapsed: ['t-32', 't-35'],
                tasksView: 'board',
            });
            expect(second.forProject('p2')).toMatchObject({
                tasksScope: 't-9',
                tasksSubtasks: false,
                taskPageView: 'board',
                tasksCollapsed: [],
            });
            expect(second.forProject('p3')).toMatchObject({
                tasksScope: null,
                tasksSubtasks: false,
                tasksCollapsed: [],
            });
        });

        it('reads a project stored before they existed: the defaults, and the rest as it was', () => {
            const ui = new UiStore(
                memoryStorage({ 'clowdy:ui:p1': '{"section":"tasks","taskId":"t7","tasksView":"list"}' })
            ).forProject('p1');

            // The section an older version stored is ignored: there is one screen.
            expect(ui).toMatchObject({
                taskId: 't7',
                tasksView: 'list',
                tasksScope: null,
                tasksSubtasks: false,
                taskPageView: 'board',
                tasksCollapsed: [],
            });
        });

        it('takes what it can from a stored value of a shape it does not know, and the defaults for the rest', () => {
            const damaged = (value: object) =>
                new UiStore(memoryStorage({ 'clowdy:ui:p1': JSON.stringify(value) })).forProject('p1');

            expect(
                damaged({ tasksScope: 5, tasksSubtasks: 'yes', taskPageView: 'cards', tasksCollapsed: 't-1' })
            ).toMatchObject({ tasksScope: null, tasksSubtasks: false, taskPageView: 'board', tasksCollapsed: [] });
            expect(
                damaged({ tasksScope: { id: 't-1' }, tasksSubtasks: 1, taskPageView: null, tasksCollapsed: null })
            ).toMatchObject({ tasksScope: null, tasksSubtasks: false, taskPageView: 'board', tasksCollapsed: [] });
            // A list with something else in it keeps its ids, once each.
            expect(damaged({ tasksCollapsed: ['t-1', 7, null, 't-2', 't-1', {}] }).tasksCollapsed).toEqual([
                't-1',
                't-2',
            ]);
        });

        it('keeps no more folds than the limit, the newest ones, from storage and as they are made', () => {
            const many = Array.from({ length: COLLAPSED_TASKS_LIMIT + 50 }, (_, index) => `t-${index}`);
            const ui = new UiStore(
                memoryStorage({ 'clowdy:ui:p1': JSON.stringify({ tasksCollapsed: many }) })
            ).forProject('p1');

            expect(ui.tasksCollapsed).toHaveLength(COLLAPSED_TASKS_LIMIT);
            expect(ui.tasksCollapsed.at(-1)).toBe(many.at(-1));

            ui.toggleTaskCollapsed('t-new');

            expect(ui.tasksCollapsed).toHaveLength(COLLAPSED_TASKS_LIMIT);
            expect(ui.tasksCollapsed.at(-1)).toBe('t-new');
            expect(ui.tasksCollapsed).not.toContain('t-50');
        });

        it('is not a place of the window: the view has no scope and no open task', () => {
            const ui = new UiStore().forProject('p1');

            ui.setTasksScope('t-31');
            ui.openTask('t-33');

            expect(ui.view).not.toHaveProperty('tasksScope');
            expect(ui.view).not.toHaveProperty('taskId');
            expect(ui.view).not.toHaveProperty('tasksSubtasks');
        });

        it('sets the scope without moving the window or closing the open task', () => {
            const ui = new UiStore().forProject('p1');

            ui.openChat('c1');
            ui.setTasksScope('t-31');

            expect([ui.chatId, ui.taskId]).toEqual(['c1', null]);

            ui.openTask('t-33');
            ui.setTasksScope('t-32');
            expect([ui.taskId, ui.tasksScope]).toEqual(['t-33', 't-32']);

            ui.openTask('t-24');
            expect(ui.tasksScope).toBe('t-32');
        });

        it('resolves the scope against the tasks the project holds: the roots when its task is gone, deleted or archived, without forgetting it', () => {
            const ui = new UiStore().forProject('p1');

            expect(ui.resolveTasksScope(held('t-31'))).toBeNull();

            ui.setTasksScope('t-31');

            expect(ui.resolveTasksScope(held('t-31', 't-32'))).toBe('t-31');
            expect(ui.resolveTasksScope(held('t-32'))).toBeNull();
            expect(ui.resolveTasksScope(new Map([['t-31', { archivedAt: 5000 }]]))).toBeNull();
            // Nothing was written: the task comes back with its scope.
            expect(ui.tasksScope).toBe('t-31');
            expect(ui.resolveTasksScope(held('t-31'))).toBe('t-31');
        });

        it('folds and opens the insides of a task, and opens several at once', () => {
            const ui = new UiStore().forProject('p1');

            ui.toggleTaskCollapsed('t-32');
            ui.toggleTaskCollapsed('t-35');
            expect(ui.tasksCollapsed).toEqual(['t-32', 't-35']);

            ui.toggleTaskCollapsed('t-32');
            expect(ui.tasksCollapsed).toEqual(['t-35']);

            ui.toggleTaskCollapsed('t-32');
            ui.expandTasks(['t-35', 't-99']);
            expect(ui.tasksCollapsed).toEqual(['t-32']);

            const before = ui.tasksCollapsed;

            ui.expandTasks(['t-99']);
            expect(ui.tasksCollapsed).toBe(before);
        });

        it('lets go of the folds of tasks the project no longer holds, and only of those', () => {
            const ui = new UiStore().forProject('p1');

            ui.toggleTaskCollapsed('t-32');
            ui.toggleTaskCollapsed('t-35');
            ui.toggleTaskCollapsed('t-gone');
            ui.forgetCollapsedTasks(held('t-32', 't-35', 't-36'));
            expect(ui.tasksCollapsed).toEqual(['t-32', 't-35']);

            const before = ui.tasksCollapsed;

            ui.forgetCollapsedTasks(held('t-32', 't-35'));
            expect(ui.tasksCollapsed).toBe(before);
        });

        it('forgets them with the project', () => {
            const storage = memoryStorage();
            const store = new UiStore(storage);

            store.forProject('p1').setTasksScope('t-31');
            store.forgetProject('p1');

            expect(new UiStore(storage).forProject('p1').tasksScope).toBeNull();
        });
    });

    describe("the comment a task's composer holds and has not sent", () => {
        it('is kept per task, and is empty for a task that has none', () => {
            const ui = new UiStore().forProject('p1');

            ui.setCommentDraft('t-32', 'Half a thought');
            ui.setCommentDraft('t-35', 'Another');

            expect([ui.commentDraft('t-32'), ui.commentDraft('t-35'), ui.commentDraft('t-36')]).toEqual([
                'Half a thought',
                'Another',
                '',
            ]);
            expect(new UiStore().forProject('p1').commentDraft('t-32')).toBe('');
        });

        it('is forgotten when its text is emptied, or holds only whitespace', () => {
            const ui = new UiStore().forProject('p1');

            ui.setCommentDraft('t-32', 'Half a thought');
            ui.setCommentDraft('t-32', '');

            expect(ui.commentDraft('t-32')).toBe('');

            ui.setCommentDraft('t-32', 'Again');
            ui.setCommentDraft('t-32', ' \n ');

            expect(ui.commentDraft('t-32')).toBe('');
        });

        it('is not stored, so a restart starts without it, and is no part of the place history shows', () => {
            const storage = memoryStorage();
            const ui = new UiStore(storage).forProject('p1');

            ui.setCommentDraft('t-32', 'Half a thought');
            ui.openTask('t-32');

            expect(JSON.stringify(storage.data)).not.toContain('Half a thought');
            expect(JSON.stringify(ui.view)).not.toContain('Half a thought');
            expect(new UiStore(storage).forProject('p1').commentDraft('t-32')).toBe('');
        });

        it('is one per project', () => {
            const store = new UiStore();

            store.forProject('p1').setCommentDraft('t-32', 'Half a thought');

            expect(store.forProject('p2').commentDraft('t-32')).toBe('');
        });

        it('keeps no more than the limit: the draft written longest ago goes, and writing again makes a draft the newest', () => {
            const ui = new UiStore().forProject('p1');

            for (let index = 0; index < COMMENT_DRAFTS_LIMIT; index++)
                ui.setCommentDraft(`t-${index}`, `Draft ${index}`);

            // The oldest is written again and so is the newest now: the next one in line goes instead.
            ui.setCommentDraft('t-0', 'Draft 0, longer');
            ui.setCommentDraft('t-new', 'One more');

            expect(ui.commentDraft('t-1')).toBe('');
            expect(ui.commentDraft('t-0')).toBe('Draft 0, longer');
            expect(ui.commentDraft('t-new')).toBe('One more');
            expect(ui.commentDraft(`t-${COMMENT_DRAFTS_LIMIT - 1}`)).toBe(`Draft ${COMMENT_DRAFTS_LIMIT - 1}`);
        });
    });

    describe('opening a task reveals it on the Tasks screen', () => {
        /** 31 holds 32 and 35, 32 holds 33; 24 is a root; 38 is archived. */
        const tasks = new Map<string, { id: string; parentId?: string; archivedAt?: number }>([
            ['t-24', { id: 't-24' }],
            ['t-31', { id: 't-31' }],
            ['t-32', { id: 't-32', parentId: 't-31' }],
            ['t-33', { id: 't-33', parentId: 't-32' }],
            ['t-35', { id: 't-35', parentId: 't-31' }],
            ['t-38', { id: 't-38', archivedAt: 5 }],
        ]);
        const open = () => new UiStore(undefined, undefined, () => tasks).forProject('p1');

        it('keeps the scope for a task inside it, and opens the folds above the task', () => {
            const ui = open();

            ui.setTasksScope('t-31');
            ui.toggleTaskCollapsed('t-32');
            ui.toggleTaskCollapsed('t-35');
            // The through board and the tree list draw every level.
            ui.setTasksSubtasks(true);
            ui.openTask('t-33');

            expect([ui.taskId, ui.tasksScope]).toEqual(['t-33', 't-31']);
            expect(ui.tasksCollapsed).toEqual(['t-35']);
        });

        it('moves the scope to the parent of a task outside it, and to the roots for a root', () => {
            const ui = open();

            ui.setTasksScope('t-35');
            ui.openTask('t-33');

            expect(ui.tasksScope).toBe('t-32');

            ui.openTask('t-24');

            expect(ui.tasksScope).toBeNull();
        });

        it('keeps the scope for the roots with the list or the through board, which draw every level, and goes to the parent on a board of one level', () => {
            const ui = open();

            ui.setTasksView('list');
            ui.openTask('t-33');

            expect(ui.tasksScope).toBeNull();

            ui.setTasksView('board');
            ui.openTask('t-33');

            // The first level of the roots has no card for it.
            expect(ui.tasksScope).toBe('t-32');

            ui.setTasksScope(null);
            ui.setTasksSubtasks(true);
            ui.openTask('t-33');

            expect(ui.tasksScope).toBeNull();
        });

        it("reads the view of the task page inside a task, and the project's own view at the roots", () => {
            const ui = open();

            ui.setTasksScope('t-31');
            ui.setTasksView('list');
            ui.openTask('t-33');

            // The task page is a board of one level, whatever the project's view is.
            expect(ui.tasksScope).toBe('t-32');

            ui.setTasksScope('t-31');
            ui.setTaskPageView('list');
            ui.openTask('t-33');

            expect(ui.tasksScope).toBe('t-31');
        });

        it('shows a remembered scope that is gone as the roots, and writes the one it settled on', () => {
            const ui = open();

            ui.setTasksScope('t-gone');
            ui.openTask('t-24');

            expect(ui.tasksScope).toBeNull();
        });

        it('puts the screen where a task that was just made will show, though the project does not hold it yet', () => {
            const ui = open();

            ui.setTasksScope('t-31');
            // Made inside CAR-32: a card of the level of CAR-32, so the board of one level goes there.
            ui.openTask('t-new', { madeIn: 't-32' });

            expect([ui.taskId, ui.tasksScope]).toEqual(['t-new', 't-32']);

            // Made at the roots, from inside a task.
            ui.openTask('t-newer', { madeIn: null });

            expect([ui.taskId, ui.tasksScope]).toEqual(['t-newer', null]);

            // Made inside the scope: it stays.
            ui.setTasksScope('t-31');
            ui.openTask('t-newest', { madeIn: 't-31' });

            expect([ui.taskId, ui.tasksScope]).toEqual(['t-newest', 't-31']);
        });

        it('leaves the screen where it is when the screen opens a task it draws itself', () => {
            const ui = open();

            ui.openTask('t-33', { reveal: false });

            expect([ui.taskId, ui.tasksScope]).toEqual(['t-33', null]);
        });

        it('leaves the scope alone for a task the project does not hold, and for the one that closes the panel', () => {
            const ui = open();

            ui.setTasksScope('t-31');
            ui.openTask('t-38');
            ui.openTask('t-missing');

            expect(ui.tasksScope).toBe('t-31');

            ui.openTask(null);

            expect([ui.taskId, ui.tasksScope]).toEqual([null, 't-31']);
        });

        it("leaves the archive view for a task of the board opened from elsewhere, and stays in it for an archived task and for the screen's own clicks", () => {
            const ui = open();

            ui.setTasksArchive(true);
            ui.openTask('t-38');
            ui.openTask('t-missing');
            ui.openTask('t-24', { reveal: false });
            ui.openTask(null);

            expect(ui.tasksArchive).toBe(true);

            ui.openTask('t-24');

            expect([ui.tasksArchive, ui.taskId]).toEqual([false, 't-24']);

            ui.setTasksArchive(true);
            // A task just made, which the project does not hold yet, is where the person looks next.
            ui.openTask('t-new', { madeIn: null });

            expect(ui.tasksArchive).toBe(false);
        });

        it('does not keep the archive view between sessions, and it is no place of the history', () => {
            const storage = memoryStorage();
            const ui = new UiStore(storage).forProject('p1');

            ui.setTasksArchive(true);

            expect(ui.tasksArchive).toBe(true);
            expect(Object.keys(ui.view)).not.toContain('tasksArchive');
            expect(new UiStore(storage).forProject('p1').tasksArchive).toBe(false);
        });

        it("does nothing to the scope without the project's tasks, as a window state of its own has none", () => {
            const ui = new UiStore().forProject('p1');

            ui.setTasksScope('t-35');
            ui.openTask('t-24');

            expect(ui.tasksScope).toBe('t-35');
        });
    });

    it('starts from defaults when the stored value is damaged', () => {
        const ui = new UiStore(
            memoryStorage({ 'clowdy:ui:p1': '{"section":"nope","taskId":5,"tasksView":"cards"}' })
        ).forProject('p1');

        expect(ui).toMatchObject({ taskId: null, tasksView: 'board' });
        expect(new UiStore(memoryStorage({ 'clowdy:ui:p1': 'not json' })).forProject('p1').chatId).toBeNull();
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

    it('shuts Settings when a place is shown, as back and forward show one: Settings is a window over a place, not a place', () => {
        const store = new UiStore();
        const ui = store.forProject('p1');

        store.openSettings('skills');
        store.restore(ui, { ...ui.view, chatId: 'c1' });

        expect([store.settingsOpen, store.settingsPage, ui.chatId]).toEqual([false, 'skills', 'c1']);
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

    it('ignores a section an older version stored under the name Chats, and keeps the chat', () => {
        const ui = new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"section":"chats","chatId":"c-1"}' })).forProject(
            'p1'
        );

        expect(ui).toMatchObject({ chatId: 'c-1' });
    });

    it('starts from what the page URL preselects, ahead of the stored state', () => {
        const initial = initialUiFromSearch(
            '?fixtures=1&panel=open&panelTab=tasks&task=t-24&view=list&chat=c-1&run=r-1'
        );
        const ui = new UiStore(
            memoryStorage({ 'clowdy:ui:p1': '{"section":"agents","tasksView":"board"}' }),
            initial
        ).forProject('p1');

        expect(ui).toMatchObject({
            taskId: 't-24',
            tasksView: 'list',
            chatId: 'c-1',
            runId: 'r-1',
            sidePanelOpen: true,
            sidePanelTab: 'tasks',
        });
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
        expect(
            new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"expandedChats":"c-1"}' })).forProject('p1')
        ).toMatchObject({ expandedChats: [] });
        expect(
            new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"expandedChats":["c-1",5]}' })).forProject('p1').expandedChats
        ).toEqual(['c-1']);
    });

    it('folds the running-agents strip by default and remembers manual toggles per project', () => {
        const storage = memoryStorage();
        const store = new UiStore(storage);
        const ui = store.forProject('p1');

        expect(ui.agentsFolded).toBe(true);

        ui.toggleAgentsFolded();
        expect(ui.agentsFolded).toBe(false);
        expect(store.forProject('p2').agentsFolded).toBe(true);
        expect(new UiStore(storage).forProject('p1').agentsFolded).toBe(false);

        ui.toggleAgentsFolded();
        expect(new UiStore(storage).forProject('p1').agentsFolded).toBe(true);
    });

    it('uses the folded default for projects that saved the old open default', () => {
        const storage = memoryStorage({ 'clowdy:ui:p1': '{"agentsFolded":false,"sidePanelOpen":true}' });
        const ui = new UiStore(storage).forProject('p1');

        expect(ui.agentsFolded).toBe(true);
        expect(ui.sidePanelOpen).toBe(true);
    });

    it('keeps the side panel closed until the person opens it, and remembers it per project', () => {
        const storage = memoryStorage();
        const store = new UiStore(storage);
        const ui = store.forProject('p1');

        expect(ui.sidePanelOpen).toBe(false);

        ui.toggleSidePanel();
        expect(ui.sidePanelOpen).toBe(true);
        expect(store.forProject('p2').sidePanelOpen).toBe(false);
        expect(new UiStore(storage).forProject('p1').sidePanelOpen).toBe(true);

        ui.toggleSidePanel();
        expect(new UiStore(storage).forProject('p1').sidePanelOpen).toBe(false);
    });

    it('reads the side panel from the page URL', () => {
        expect(initialUiFromSearch('?panel=open')).toEqual({ sidePanelOpen: true });
        expect(initialUiFromSearch('?panel=closed')).toEqual({ sidePanelOpen: false });
        expect(new UiStore(memoryStorage(), initialUiFromSearch('?panel=open')).forProject('p1').sidePanelOpen).toBe(
            true
        );
    });

    it('starts the side panel on its Info tab, and keeps the tab the person left it on per project', () => {
        const storage = memoryStorage();
        const store = new UiStore(storage);
        const ui = store.forProject('p1');

        expect(ui.sidePanelTab).toBe('info');

        ui.showSidePanelTab('files');
        expect(ui.sidePanelTab).toBe('files');
        expect(store.forProject('p2').sidePanelTab).toBe('info');
        expect(new UiStore(storage).forProject('p1').sidePanelTab).toBe('files');
    });

    it('shuts the side panel, and does nothing to a shut one', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        ui.closeSidePanel();
        expect(ui.sidePanelOpen).toBe(false);

        ui.toggleSidePanel();
        ui.closeSidePanel();
        expect(ui.sidePanelOpen).toBe(false);
    });

    it('keeps the side panel expanded apart from whether it is open, per project and between sessions', () => {
        const storage = memoryStorage();
        const store = new UiStore(storage);
        const ui = store.forProject('p1');

        expect(ui.sidePanelExpanded).toBe(false);

        ui.toggleSidePanel();
        ui.toggleSidePanelExpanded();
        expect(ui.sidePanelExpanded).toBe(true);

        // A shut panel keeps the choice, and comes back expanded.
        ui.toggleSidePanel();
        expect(ui.sidePanelExpanded).toBe(true);
        ui.toggleSidePanelTab('terminal');
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([true, true]);

        expect(store.forProject('p2').sidePanelExpanded).toBe(false);
        expect(new UiStore(storage).forProject('p1').sidePanelExpanded).toBe(true);

        ui.toggleSidePanelExpanded();
        expect(new UiStore(storage).forProject('p1').sidePanelExpanded).toBe(false);
    });

    it('shuts a panel that covers the chat when a chat is chosen, and leaves the choice of the expanded size', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');
        const choose = [
            ['a chat', () => ui.openChat('c1')],
            ['the chat that is open already', () => ui.openChat(ui.chatId)],
            ['a run', () => ui.openRun('r1')],
            ['the new-chat row', () => ui.openDraft()],
        ] as const;

        for (const [, open] of choose) {
            ui.sidePanelOpen = true;
            ui.sidePanelExpanded = true;
            open();
            expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([false, true]);
        }

        // The panel comes back where the chat has not moved, expanded as it was left.
        ui.toggleSidePanel();
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([true, true]);
    });

    it('leaves a panel beside the chat, and a shut one, as they are when a chat is chosen', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        ui.sidePanelOpen = true;
        ui.openChat('c1');
        ui.openRun('r1');
        ui.openDraft();
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([true, false]);

        ui.sidePanelOpen = false;
        ui.sidePanelExpanded = true;
        ui.openChat('c2');
        ui.openRun('r2');
        ui.openDraft();
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([false, true]);
    });

    it('shuts a panel that covers the chat when history shows another chat, and not when it shows the same one', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        ui.openChat('c1');
        ui.sidePanelOpen = true;
        ui.sidePanelExpanded = true;

        ui.show({ ...ui.view });
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([true, true]);

        ui.show({ ...ui.view, chatId: 'c2' });
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([false, true]);
    });

    it('opens the side panel on a tab from a shut panel or another tab, and never shuts it', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        ui.openSidePanelTab('files');
        expect([ui.sidePanelOpen, ui.sidePanelTab]).toEqual([true, 'files']);

        ui.openSidePanelTab('files');
        expect([ui.sidePanelOpen, ui.sidePanelTab]).toEqual([true, 'files']);

        ui.openSidePanelTab('terminal');
        expect([ui.sidePanelOpen, ui.sidePanelTab]).toEqual([true, 'terminal']);

        ui.toggleSidePanel();
        ui.openSidePanelTab('terminal');
        expect([ui.sidePanelOpen, ui.sidePanelTab]).toEqual([true, 'terminal']);
    });

    it("sets the side panel to one of its three sizes: beside the chat, in the chat's place, or hidden", () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');
        const state = () => [ui.sidePanelOpen, ui.sidePanelExpanded];

        expect(state()).toEqual([false, false]);

        ui.setSidePanelSize('wide');
        expect(state()).toEqual([true, true]);

        ui.setSidePanelSize('half');
        expect(state()).toEqual([true, false]);

        ui.setSidePanelSize('hide');
        expect(state()).toEqual([false, false]);

        ui.setSidePanelSize('half');
        ui.setSidePanelSize('half');
        expect(state()).toEqual([true, false]);
    });

    it('keeps the choice of the expanded size when the panel is hidden, so it comes back in it by the keys', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        ui.setSidePanelSize('wide');
        ui.setSidePanelSize('hide');
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([false, true]);

        ui.toggleSidePanel();
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([true, true]);
    });

    it("puts Files and Docs in the chat's place while the window is too narrow for them beside it, and leaves the other tabs and the choice alone", () => {
        const store = new UiStore(memoryStorage());
        const ui = store.forProject('p1');

        ui.openSidePanelTab('files');
        expect([ui.sidePanelTabIsFull, ui.sidePanelCoversChat]).toEqual([false, false]);

        store.setWindowFitsHalf(false);
        expect([ui.sidePanelTabIsFull, ui.sidePanelCoversChat, ui.sidePanelExpanded]).toEqual([true, true, false]);

        ui.showSidePanelTab('docs');
        expect(ui.sidePanelCoversChat).toBe(true);

        for (const tab of ['terminal', 'info'] as const) {
            ui.showSidePanelTab(tab);
            expect([ui.sidePanelTabIsFull, ui.sidePanelCoversChat]).toEqual([false, false]);
        }

        // Wider again, the project's own choice is back: nothing was kept.
        ui.showSidePanelTab('files');
        store.setWindowFitsHalf(true);
        expect([ui.sidePanelTabIsFull, ui.sidePanelCoversChat, ui.sidePanelExpanded]).toEqual([false, false, false]);
    });

    it('sets the size of a panel that is full for the width of the window as it does for Tasks: shown or hidden, and the choice as it was', () => {
        const store = new UiStore(memoryStorage());
        const ui = store.forProject('p1');

        ui.showSidePanelTab('files');
        store.setWindowFitsHalf(false);

        ui.setSidePanelSize('half');
        expect([ui.sidePanelOpen, ui.sidePanelExpanded, ui.sidePanelCoversChat]).toEqual([true, false, true]);

        ui.setSidePanelSize('hide');
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([false, false]);
    });

    it('knows that Files, Docs and Changes are a list beside a view', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        expect(
            (['files', 'docs', 'terminal', 'info', 'tasks', 'changes'] as const).map(tab => {
                ui.showSidePanelTab(tab);

                return ui.sidePanelTabHasTree;
            })
        ).toEqual([true, true, false, false, false, true]);
    });

    it("puts Changes beside the chat while the window fits it, and in the chat's place while it does not, as Files is", () => {
        const store = new UiStore(memoryStorage());
        const ui = store.forProject('p1');

        ui.showSidePanelTab('changes');
        ui.toggleSidePanel();
        expect([ui.sidePanelNoHalf, ui.sidePanelTabIsFull, ui.sidePanelCoversChat]).toEqual([null, false, false]);

        store.setWindowFitsHalf(false);
        expect([ui.sidePanelNoHalf, ui.sidePanelTabIsFull, ui.sidePanelCoversChat]).toEqual(['window', true, true]);

        // Nothing is kept for it: in a wider window the project's own choice is back.
        store.setWindowFitsHalf(true);
        expect([ui.sidePanelNoHalf, ui.sidePanelCoversChat, ui.sidePanelExpanded]).toEqual([null, false, false]);

        // The tabs that do not have a tree stay beside the chat in a narrow window.
        store.setWindowFitsHalf(false);
        ui.showSidePanelTab('terminal');
        expect([ui.sidePanelNoHalf, ui.sidePanelCoversChat]).toEqual([null, false]);
    });

    it('covers the chat on the Tasks tab whatever the expanded choice, and only while the panel is open', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        ui.showSidePanelTab('tasks');
        expect(ui.sidePanelCoversChat).toBe(false);

        ui.toggleSidePanel();
        expect([ui.sidePanelCoversChat, ui.sidePanelExpanded]).toEqual([true, false]);

        ui.showSidePanelTab('files');
        expect(ui.sidePanelCoversChat).toBe(false);

        ui.toggleSidePanelExpanded();
        expect(ui.sidePanelCoversChat).toBe(true);
    });

    it('shuts a panel that shows the Tasks tab when a chat is chosen, and leaves the expanded choice as it was', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        ui.openSidePanelTab('tasks');
        ui.openChat('c1');
        expect([ui.sidePanelOpen, ui.sidePanelTab, ui.sidePanelExpanded]).toEqual([false, 'tasks', false]);

        // Another tab, beside the chat, is left alone by a chat choice.
        ui.openSidePanelTab('files');
        ui.openChat('c2');
        expect([ui.sidePanelOpen, ui.sidePanelTab]).toEqual([true, 'files']);
    });

    it('shows the Tasks tab for any size but hidden, and leaves the expanded choice as it was', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        ui.showSidePanelTab('tasks');
        ui.setSidePanelSize('half');
        expect([ui.sidePanelOpen, ui.sidePanelExpanded, ui.sidePanelCoversChat]).toEqual([true, false, true]);

        ui.setSidePanelSize('hide');
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([false, false]);

        ui.toggleSidePanelExpanded();
        ui.setSidePanelSize('wide');
        ui.setSidePanelSize('hide');
        expect([ui.sidePanelOpen, ui.sidePanelExpanded]).toEqual([false, true]);
    });

    it('opens the side panel on a tab, and shuts it when that tab is already shown', () => {
        const ui = new UiStore(memoryStorage()).forProject('p1');

        ui.toggleSidePanelTab('terminal');
        expect([ui.sidePanelOpen, ui.sidePanelTab]).toEqual([true, 'terminal']);

        ui.showSidePanelTab('files');
        ui.toggleSidePanelTab('terminal');
        expect([ui.sidePanelOpen, ui.sidePanelTab]).toEqual([true, 'terminal']);

        ui.toggleSidePanelTab('terminal');
        expect([ui.sidePanelOpen, ui.sidePanelTab]).toEqual([false, 'terminal']);

        ui.toggleSidePanelTab('files');
        expect([ui.sidePanelOpen, ui.sidePanelTab]).toEqual([true, 'files']);
    });

    it('reads the side panel tab from the page URL, and drops a tab that is not one', () => {
        expect(initialUiFromSearch('?panel=open&panelTab=files')).toEqual({
            sidePanelOpen: true,
            sidePanelTab: 'files',
        });
        expect(initialUiFromSearch('?panelTab=terminal')).toEqual({ sidePanelTab: 'terminal' });
        expect(initialUiFromSearch('?panelTab=docs')).toEqual({ sidePanelTab: 'docs' });
        expect(initialUiFromSearch('?panelTab=tasks')).toEqual({ sidePanelTab: 'tasks' });
        expect(initialUiFromSearch('?panelTab=changes')).toEqual({ sidePanelTab: 'changes' });
        expect(
            new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"sidePanelTab":"docs"}' })).forProject('p1').sidePanelTab
        ).toBe('docs');
        expect(
            new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"sidePanelTab":"changes"}' })).forProject('p1').sidePanelTab
        ).toBe('changes');
        expect(initialUiFromSearch('?panelTab=checks')).toEqual({});
        expect(
            new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"sidePanelTab":"terminal"}' })).forProject('p1').sidePanelTab
        ).toBe('terminal');
        // A stored tab that is none (one a later version had, or damage) falls back to Info.
        expect(
            new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"sidePanelTab":"checks"}' })).forProject('p1').sidePanelTab
        ).toBe('info');
    });

    it('reads the fold of the strip from the page URL, and drops what is damaged in storage', () => {
        expect(initialUiFromSearch('?agents=folded')).toEqual({ agentsFolded: true });
        expect(initialUiFromSearch('?agents=open')).toEqual({ agentsFolded: false });
        expect(
            new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"agentsExpanded":"yes"}' })).forProject('p1').agentsFolded
        ).toBe(true);
    });

    it('groups the list by folder until it is turned off, folds a group on its own, and keeps both per project across a restart', () => {
        const storage = memoryStorage();
        const store = new UiStore(storage);
        const ui = store.forProject('p1');

        expect([ui.groupByFolder, ui.collapsedFolders]).toEqual([true, []]);

        ui.setGroupByFolder(false);
        ui.toggleFolderCollapsed('fld-api');
        ui.toggleFolderCollapsed('fld-notes');
        ui.toggleFolderCollapsed('fld-api');
        expect(ui.collapsedFolders).toEqual(['fld-notes']);
        expect(store.forProject('p2')).toMatchObject({ groupByFolder: true, collapsedFolders: [] });
        expect(new UiStore(storage).forProject('p1')).toMatchObject({
            groupByFolder: false,
            collapsedFolders: ['fld-notes'],
        });
    });

    it('opens the folded group of a chat opened from elsewhere, and changes nothing when it is open', () => {
        const ui = new UiStore().forProject('p1');

        ui.toggleFolderCollapsed('fld-api');
        ui.expandFolder('fld-web');
        expect(ui.collapsedFolders).toEqual(['fld-api']);

        const before = ui.collapsedFolders;

        ui.expandFolder('fld-web');
        expect(ui.collapsedFolders).toBe(before);

        ui.expandFolder('fld-api');
        expect(ui.collapsedFolders).toEqual([]);
    });

    it('reads the grouping and the folded groups from the page URL, and drops what is damaged in storage', () => {
        expect(initialUiFromSearch('?group=1&collapsed=fld-api,fld-notes')).toEqual({
            groupByFolder: true,
            collapsedFolders: ['fld-api', 'fld-notes'],
        });
        expect(initialUiFromSearch('?group=0')).toEqual({ groupByFolder: false });
        // A choice that was kept stays, and what is not a choice reads as the default, grouped.
        expect(
            new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"groupByFolder":false}' })).forProject('p1').groupByFolder
        ).toBe(false);
        expect(
            new UiStore(
                memoryStorage({ 'clowdy:ui:p1': '{"groupByFolder":"yes","collapsedFolders":"fld-api"}' })
            ).forProject('p1')
        ).toMatchObject({ groupByFolder: true, collapsedFolders: [] });
        expect(
            new UiStore(memoryStorage({ 'clowdy:ui:p1': '{"collapsedFolders":["fld-api",5]}' })).forProject('p1')
                .collapsedFolders
        ).toEqual(['fld-api']);
    });

    it('makes the new-chat row for a folder, and forgets the folder once another page opens; back and forward bring it again', () => {
        const ui = new UiStore().forProject('p1');

        ui.openDraft();
        expect(ui.draftFolderId).toBeNull();

        ui.openDraft([], 'fld-api');
        expect([ui.draft, ui.draftFolderId]).toEqual([true, 'fld-api']);

        const view = ui.view;

        ui.openChat('c1');
        expect([ui.draft, ui.draftFolderId]).toEqual([false, null]);

        ui.show(view);
        expect([ui.draft, ui.draftFolderId]).toEqual([true, 'fld-api']);

        ui.openRun('r1');
        expect(ui.draftFolderId).toBeNull();
    });

    it('changes the folder of the open new-chat page without opening another page, and null is the main folder', () => {
        const ui = new UiStore().forProject('p1');

        ui.openDraft([], 'fld-api');
        ui.setDraftFolder('fld-notes');
        expect([ui.draft, ui.draftFolderId]).toEqual([true, 'fld-notes']);

        // The folder is part of the place the window shows (`view`).
        expect(ui.view).toMatchObject({ draft: true, draftFolderId: 'fld-notes' });

        ui.setDraftFolder(null);
        expect([ui.draft, ui.draftFolderId]).toEqual([true, null]);
    });

    it('keeps no folder when no new-chat page is open', () => {
        const ui = new UiStore().forProject('p1');

        ui.openChat('c1');
        ui.setDraftFolder('fld-api');
        expect([ui.draft, ui.draftFolderId]).toEqual([false, null]);
    });

    describe('where the new chat works in its folder', () => {
        it("starts in the folder's own checkout, whatever the page was before, and is part of the place (`view`)", () => {
            const ui = new UiStore().forProject('p1');

            ui.openDraft();
            expect(ui.draftWorkspace).toBeNull();

            ui.setDraftWorkspace({ mode: 'new', base: 'origin/dev' });
            expect(ui.view).toMatchObject({ draft: true, draftWorkspace: { mode: 'new', base: 'origin/dev' } });

            // Opening the page again, for a folder or not, starts it over.
            ui.openDraft([], 'fld-api');
            expect(ui.draftWorkspace).toBeNull();
        });

        it('is forgotten once a chat or a run opens, and brought back with the page by back and forward', () => {
            const ui = new UiStore().forProject('p1');

            ui.openDraft([], 'fld-api');
            ui.setDraftWorkspace({ mode: 'existing', path: '/work/api-fix' });

            const view = ui.view;

            ui.openChat('c1');
            expect(ui.draftWorkspace).toBeNull();

            ui.show(view);
            expect([ui.draft, ui.draftFolderId, ui.draftWorkspace]).toEqual([
                true,
                'fld-api',
                { mode: 'existing', path: '/work/api-fix' },
            ]);

            ui.openRun('r1');
            expect(ui.draftWorkspace).toBeNull();
        });

        it('goes back to Project checkout when the folder changes, and stays when the same folder is picked again', () => {
            const ui = new UiStore().forProject('p1');

            ui.openDraft([], 'fld-api');
            ui.setDraftWorkspace({ mode: 'new' });
            ui.setDraftFolder('fld-api');
            expect(ui.draftWorkspace).toEqual({ mode: 'new' });

            // A worktree or a base belongs to the repository it was chosen for.
            ui.setDraftFolder('fld-notes');
            expect(ui.draftWorkspace).toBeNull();

            ui.setDraftWorkspace({ mode: 'new', base: 'main' });
            ui.setDraftFolder(null);
            expect(ui.draftWorkspace).toBeNull();
        });

        it('is kept only with the new-chat page open', () => {
            const ui = new UiStore().forProject('p1');

            ui.openChat('c1');
            ui.setDraftWorkspace({ mode: 'new' });
            expect(ui.draftWorkspace).toBeNull();
        });

        describe("the daemon's row of the worktree it chose", () => {
            const row = {
                id: 'wks_found',
                folderId: 'fld-api',
                path: '/work/api-fix',
                branch: 'fix',
                managed: false,
                ready: true,
            };
            const existing = { mode: 'existing', path: '/work/api-fix' } as const;
            const chosen = () => {
                const ui = new UiStore().forProject('p1');

                ui.openDraft([], 'fld-api', existing);
                ui.setDraftWorkspaceRow(row);

                return ui;
            };

            it('is kept by the page, and starts empty', () => {
                const ui = new UiStore().forProject('p1');

                ui.openDraft([], 'fld-api', existing);
                expect(ui.draftWorkspaceRow).toBeNull();

                ui.setDraftWorkspaceRow(row);
                expect(ui.draftWorkspaceRow).toEqual(row);
            });

            it('stays when the same worktree is chosen again, and goes when the choice changes', () => {
                const ui = chosen();

                ui.setDraftWorkspace({ mode: 'existing', path: '/work/api-fix' });
                expect(ui.draftWorkspaceRow).toEqual(row);

                ui.setDraftWorkspace({ mode: 'existing', path: '/work/api-other' });
                expect(ui.draftWorkspaceRow).toBeNull();

                ui.setDraftWorkspaceRow(row);
                ui.setDraftWorkspace({ mode: 'new' });
                expect(ui.draftWorkspaceRow).toBeNull();

                ui.setDraftWorkspaceRow(row);
                ui.setDraftWorkspace(null);
                expect(ui.draftWorkspaceRow).toBeNull();
            });

            it('goes with the folder, and stays when the same folder is picked again', () => {
                const ui = chosen();

                ui.setDraftFolder('fld-api');
                expect(ui.draftWorkspaceRow).toEqual(row);

                ui.setDraftFolder('fld-notes');
                expect(ui.draftWorkspaceRow).toBeNull();
            });

            it('goes when a chat or a run opens, when the page is opened again and when a place is shown again (the page asks for the one it is given)', () => {
                const ui = chosen();
                const view = ui.view;

                ui.openChat('c1');
                expect(ui.draftWorkspaceRow).toBeNull();

                ui.show(view);
                expect(ui.draftWorkspaceRow).toBeNull();

                ui.setDraftWorkspaceRow(row);
                ui.openRun('r1');
                expect(ui.draftWorkspaceRow).toBeNull();

                ui.openDraft([], 'fld-api', existing);
                expect(ui.draftWorkspaceRow).toBeNull();
            });

            it('is not part of the place that history keeps, and is kept only with the new-chat page open', () => {
                const ui = chosen();

                expect(ui.view).not.toHaveProperty('draftWorkspaceRow');

                ui.openChat('c1');
                ui.setDraftWorkspaceRow(row);
                expect(ui.draftWorkspaceRow).toBeNull();
            });
        });
    });

    describe('the agent the new chat starts on', () => {
        it('is none unless the page was opened for one, and the next page opened starts over', () => {
            const ui = new UiStore().forProject('p1');

            ui.openDraft();
            expect(ui.draftEngine).toBeNull();

            ui.openDraft([], null, null, 'codex');
            expect(ui.draftEngine).toBe('codex');

            // The page opened from the list again is not for the agent a hand-off named.
            ui.openDraft();
            expect(ui.draftEngine).toBeNull();
        });

        it('is part of the place (`view`): forgotten once a chat or a run opens, and brought back with the page by back and forward', () => {
            const ui = new UiStore().forProject('p1');

            ui.openDraft([], 'fld-api', { mode: 'existing', path: '/work/api-fix' }, 'codex');
            expect(ui.view).toMatchObject({ draft: true, draftFolderId: 'fld-api', draftEngine: 'codex' });

            const view = ui.view;

            ui.openChat('c1');
            expect(ui.draftEngine).toBeNull();

            ui.show(view);
            expect([ui.draft, ui.draftEngine]).toEqual([true, 'codex']);

            ui.openRun('r1');
            expect(ui.draftEngine).toBeNull();
        });

        it('stays when the folder of the page changes: the agent is no choice about a folder', () => {
            const ui = new UiStore().forProject('p1');

            ui.openDraft([], 'fld-api', null, 'cursor');
            ui.setDraftFolder('fld-notes');
            expect(ui.draftEngine).toBe('cursor');
        });
    });

    it('ignores URL values that name no view, and a section, which is gone', () => {
        expect(initialUiFromSearch('?section=tasks&view=cards')).toEqual({});
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

    it('shows the page of a project over Settings > Projects, or the list again, without changing the page of Settings', () => {
        const ui = new UiStore();

        ui.openSettings('providers');
        ui.setSettingsProject('p1');
        expect([ui.settingsPage, ui.settingsProjectId]).toEqual(['providers', 'p1']);

        ui.setSettingsProject(null);
        expect([ui.settingsPage, ui.settingsProjectId]).toEqual(['providers', null]);
    });

    it('forgets a removed project: its window state, its stored copy, and its page in Settings', () => {
        const storage = memoryStorage({ 'clowdy:ui:p1': JSON.stringify({ chatId: 'c1' }) });
        const ui = new UiStore(storage as KeyValueStorage);

        expect(ui.forProject('p1').chatId).toBe('c1');
        ui.openProjectSettings('p1');
        ui.forgetProject('p1');

        expect(ui.settingsProjectId).toBeNull();
        expect(storage.data['clowdy:ui:p1']).toBeUndefined();
        expect(ui.forProject('p1').chatId).toBeNull();
    });
});
