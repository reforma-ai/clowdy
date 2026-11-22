import { reaction } from 'mobx';
import { describe, expect, it } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { overrideTransport } from '../daemon/testing';
import { ARCHIVED_MEMORY_LIMIT, ProjectState, UNRESOLVED_KEYS_LIMIT } from './ProjectState';

import type { ClowdyEvent, EventData, Run, Task, TaskComment } from '@clowdy/protocol';
import type { Transport } from '../daemon/transport';

async function loadedProject() {
    const data = createFixtureData();
    const transport = new FixtureTransport({ data });
    const state = new ProjectState(transport, data.projects[0]);

    await state.load();

    return { data, transport, state };
}

const event = (cursor: number, data: EventData): ClowdyEvent => ({ cursor, at: 0, projectId: FIXTURE_PROJECT_ID, data });

describe('ProjectState', () => {
    it('loads the snapshot and starts its cursor there', async () => {
        const { state } = await loadedProject();

        expect(state.status).toBe('ready');
        expect(state.cursor).toBe(1000);
        expect(state.tasks.get('t-24')?.title).toBe('Update the booking form');
        // Six chats the person made and the five threads of Ship the checkout.
        expect(state.chats.size).toBe(11);
    });

    it('applies an upsert event once its cursor is past the snapshot cursor, and advances', async () => {
        const { state } = await loadedProject();
        const task = { ...state.tasks.get('t-24')!, title: 'Renamed' };

        state.applyEvent(event(1001, { type: 'task.upserted', task }));

        expect(state.tasks.get('t-24')?.title).toBe('Renamed');
        expect(state.cursor).toBe(1001);
    });

    it('skips an event at or before the snapshot cursor, because the snapshot already holds it', async () => {
        const { state } = await loadedProject();
        const stale = { ...state.tasks.get('t-24')!, title: 'Stale' };

        state.applyEvent(event(1000, { type: 'task.upserted', task: stale }));
        state.applyEvent(event(990, { type: 'task.upserted', task: stale }));

        expect(state.tasks.get('t-24')?.title).toBe('Update the booking form');
        expect(state.cursor).toBe(1000);
    });

    it('does not apply the same event twice or an older one after a newer one', async () => {
        const { state } = await loadedProject();
        const first = { ...state.tasks.get('t-24')!, title: 'First' };
        const second = { ...first, title: 'Second' };

        state.applyEvent(event(1002, { type: 'task.upserted', task: second }));
        state.applyEvent(event(1001, { type: 'task.upserted', task: first }));

        expect(state.tasks.get('t-24')?.title).toBe('Second');
    });

    it('holds events that arrive during the first load and applies those newer than the snapshot', async () => {
        const data = createFixtureData();
        const transport = new FixtureTransport({ data });
        const state = new ProjectState(transport, data.projects[0]);
        const loading = state.load();
        const task = (title: string): Task => ({ ...data.tasks[0], title });

        state.applyEvent(event(999, { type: 'task.upserted', task: task('Older than the snapshot') }));
        state.applyEvent(event(1001, { type: 'task.upserted', task: task('Newer than the snapshot') }));
        await loading;

        expect(state.tasks.get(data.tasks[0].id)?.title).toBe('Newer than the snapshot');
        expect(state.cursor).toBe(1001);
    });

    it('drops a deleted task together with its links', async () => {
        const { state } = await loadedProject();

        expect(state.runsOfTask('t-24').map(run => run.id)).toEqual(['r-orch-1', 'r-orch-5']);
        state.applyEvent(event(1001, { type: 'task.deleted', taskId: 't-24' }));

        expect(state.tasks.has('t-24')).toBe(false);
        expect(state.runsOfTask('t-24')).toEqual([]);
        expect(state.tasksOfChat('c-1').map(task => task.key)).not.toContain('CAR-24');
    });

    describe('archived tasks', () => {
        it('takes a task off the board when it is archived, and puts it back when it is restored', async () => {
            const { state } = await loadedProject();
            const archived: Task = { ...state.tasks.get('t-22')!, archivedAt: 5000 };
            const { archivedAt: _, ...restored } = archived;

            state.applyEvent(event(1001, { type: 'task.upserted', task: archived }));

            expect(state.tasks.has('t-22')).toBe(false);
            expect(state.taskList.map(task => task.number)).not.toContain(22);
            expect(state.tasksByStatus.get('done')?.map(task => task.number)).toEqual([20, 21, 33]);

            state.applyEvent(event(1002, { type: 'task.upserted', task: restored }));

            expect(state.tasks.get('t-22')).toEqual(restored);
            expect(state.tasksByStatus.get('done')?.map(task => task.number)).toEqual([20, 21, 22, 33]);
        });

        it('takes every task of an archived batch off the board, one event each', async () => {
            const { state } = await loadedProject();

            for (const [index, id] of ['t-31', 't-32', 't-33'].entries()) {
                state.applyEvent(event(1001 + index, { type: 'task.upserted', task: { ...state.tasks.get(id)!, archivedAt: 7000 } }));
            }

            expect(['t-31', 't-32', 't-33'].map(id => state.tasks.has(id))).toEqual([false, false, false]);
            expect(state.tasks.has('t-34')).toBe(true);
        });

        it('is not in a snapshot taken after the archive, which still carries its links, and an archived task that is deleted leaves them nowhere', async () => {
            const { state, transport } = await loadedProject();

            expect(await transport.command({ type: 'task.archive', taskId: 't-21' })).toMatchObject({ ok: true });

            state.applySnapshot(await transport.getProjectSnapshot(state.id));
            expect(state.tasks.has('t-21')).toBe(false);

            // The snapshot leaves the row out and keeps the links of the archived task.
            expect([...state.runTaskLinks.values()].some(link => link.taskId === 't-21')).toBe(true);
            expect([...state.chatTaskLinks.values()].some(link => link.taskId === 't-21')).toBe(true);

            state.applyEvent(event(state.cursor + 1, { type: 'task.deleted', taskId: 't-21' }));
            expect([...state.runTaskLinks.values()].some(link => link.taskId === 't-21')).toBe(false);
            expect([...state.chatTaskLinks.values()].some(link => link.taskId === 't-21')).toBe(false);
        });

        it('ignores the chat and run links of a task it does not hold, in every derived list, and takes them back with the task', async () => {
            const { state } = await loadedProject();
            const task = state.tasks.get('t-24')!;

            expect(state.runsOfTask('t-24')).toHaveLength(2);
            expect(state.chatsOfTask('t-24').map(chat => chat.id)).toEqual(['c-1']);
            expect(state.tasksOfChat('c-1').map(candidate => candidate.number)).toContain(24);
            expect(state.tasksOfRun('r-orch-1').map(candidate => candidate.number)).toContain(24);
            expect(state.linksOfRun('r-orch-5')).toHaveLength(1);

            state.applyEvent(event(1001, { type: 'task.upserted', task: { ...task, archivedAt: 5000 } }));

            expect(state.runsOfTask('t-24')).toEqual([]);
            expect(state.chatsOfTask('t-24')).toEqual([]);
            expect(state.tasksOfChat('c-1').map(candidate => candidate.number)).not.toContain(24);
            expect(state.tasksOfRun('r-orch-1').map(candidate => candidate.number)).not.toContain(24);
            expect(state.linksOfRun('r-orch-5')).toEqual([]);
            // The links are still kept, and nothing else of the run or the chat changes.
            expect(state.runs.has('r-orch-5')).toBe(true);
            expect(state.tasksOfChat('c-1').map(candidate => candidate.number)).toEqual([20, 21, 22, 23, 25, 26, 27]);

            state.applyEvent(event(1002, { type: 'task.upserted', task }));

            expect(state.runsOfTask('t-24').map(run => run.id)).toEqual(['r-orch-1', 'r-orch-5']);
            expect(state.chatsOfTask('t-24').map(chat => chat.id)).toEqual(['c-1']);
            expect(state.linksOfRun('r-orch-5')).toHaveLength(1);
        });
    });

    describe('the archived tasks the window knows', () => {
        const archive = (state: ProjectState, id: string, cursor: number, archivedAt = 5000) => state.applyEvent(event(cursor, { type: 'task.upserted', task: { ...state.tasks.get(id)!, archivedAt } }));

        it('remembers a task that is archived by its event, and resolves it by id and by key, which the board no longer does', async () => {
            const { state } = await loadedProject();

            expect(state.taskOfKey('CAR-22')?.id).toBe('t-22');

            archive(state, 't-22', 1001);

            expect(state.tasks.has('t-22')).toBe(false);
            expect(state.archivedKnown.get('t-22')?.archivedAt).toBe(5000);
            expect(state.taskById('t-22')?.key).toBe('CAR-22');
            expect(state.taskOfKey('CAR-22')?.id).toBe('t-22');
            expect(state.taskOfKey('CAR-999')).toBeUndefined();
        });

        it('forgets a task that is restored or deleted, so it holds archived tasks only', async () => {
            const { state } = await loadedProject();

            archive(state, 't-22', 1001);
            archive(state, 't-21', 1002);

            const { archivedAt: _, ...restored } = state.archivedKnown.get('t-22')!;

            state.applyEvent(event(1003, { type: 'task.upserted', task: restored }));
            state.applyEvent(event(1004, { type: 'task.deleted', taskId: 't-21' }));

            expect([...state.archivedKnown.keys()]).toEqual([]);
            expect(state.tasks.get('t-22')).toEqual(restored);
            expect(state.taskById('t-21')).toBeUndefined();
        });

        it('counts what may change the archive: an archive, a restore, a delete of an archived task, a snapshot, and a task made on the board', async () => {
            const { state, transport } = await loadedProject();
            const seen: number[] = [];

            seen.push(state.archiveRevision);
            archive(state, 't-22', 1001);
            seen.push(state.archiveRevision);

            const { archivedAt: _, ...restored } = state.archivedKnown.get('t-22')!;

            state.applyEvent(event(1002, { type: 'task.upserted', task: restored }));
            seen.push(state.archiveRevision);
            // A task changed on the board is not the archive's business.
            state.applyEvent(event(1003, { type: 'task.upserted', task: { ...restored, title: 'Renamed' } }));
            seen.push(state.archiveRevision);
            state.applyEvent(event(1004, { type: 'task.deleted', taskId: 't-24' }));
            seen.push(state.archiveRevision);
            state.applyEvent(event(1005, { type: 'task.deleted', taskId: 't-404' }));
            seen.push(state.archiveRevision);
            state.applySnapshot(await transport.getProjectSnapshot(state.id));
            seen.push(state.archiveRevision);

            const [start] = seen;

            expect(seen.map(value => value - start)).toEqual([0, 1, 2, 2, 2, 3, 4]);
        });

        it('lets the ones read longest ago go past its limit, and moves a task read again to the end', async () => {
            const { state } = await loadedProject();
            const many = (from: number, count: number): Task[] => Array.from({ length: count }, (_, index) => ({ ...state.tasks.get('t-22')!, id: `x-${ from + index }`, key: `X-${ from + index }`, archivedAt: 9 }));

            state.rememberArchived(many(0, ARCHIVED_MEMORY_LIMIT));
            state.rememberArchived(many(0, 1));
            state.rememberArchived(many(ARCHIVED_MEMORY_LIMIT, 2));

            expect(state.archivedKnown.size).toBe(ARCHIVED_MEMORY_LIMIT);
            expect(state.archivedKnown.has('x-0')).toBe(true);
            expect(state.archivedKnown.has('x-1')).toBe(false);
            expect(state.archivedKnown.has('x-2')).toBe(false);
            expect(state.archivedKnown.has(`x-${ ARCHIVED_MEMORY_LIMIT + 1 }`)).toBe(true);
        });

        it('does not remember a task that is not archived, or one the board holds', async () => {
            const { state } = await loadedProject();

            state.rememberArchived([state.tasks.get('t-22')!, { ...state.tasks.get('t-22')!, archivedAt: 5 }, { ...state.tasks.get('t-21')!, id: 'x-1' }]);

            expect(state.archivedKnown.size).toBe(0);
        });

        it('drops from its memory what a snapshot shows on the board, which was restored while the feed was away', async () => {
            const { state, transport } = await loadedProject();

            state.rememberArchived([{ ...state.tasks.get('t-22')!, archivedAt: 5 }]);
            state.tasks.delete('t-22');
            state.rememberArchived([{ ...state.tasks.get('t-21')!, archivedAt: 6 }]);
            state.applySnapshot(await transport.getProjectSnapshot(state.id));

            // Both are on the fixture's board, so neither is archived now.
            expect(state.archivedKnown.size).toBe(0);
        });

        describe('reading a task the board does not hold', () => {
            it('reads an archived task from the daemon once, however many ask, and remembers it', async () => {
                const data = createFixtureData();
                const transport = new FixtureTransport({ data });
                const reads: string[] = [];
                const state = new ProjectState(overrideTransport(transport, { getTaskDetail: (taskId) => {
                    reads.push(taskId);

                    return transport.getTaskDetail(taskId);
                } }), data.projects[0]);

                await state.load();

                const [first, second] = await Promise.all([state.readTask('t-38'), state.readTask('t-38')]);

                expect(first?.key).toBe('CAR-38');
                expect(second).toBe(first);
                expect(reads).toEqual(['t-38']);
                expect(state.archivedKnown.get('t-38')).toBe(first);

                // Remembered: asking again does not go to the daemon.
                await state.readTask('t-38');
                expect(reads).toEqual(['t-38']);
            });

            it('answers a task on the board without the daemon, and nothing for a task the daemon does not have', async () => {
                const { state } = await loadedProject();

                expect((await state.readTask('t-24'))?.key).toBe('CAR-24');
                expect(await state.readTask('t-404')).toBeUndefined();
            });

            it('does not remember a task of another project, and answers nothing for it', async () => {
                const data = createFixtureData();
                const transport = new FixtureTransport({ data });
                const other = data.projects.find(project => project.id !== FIXTURE_PROJECT_ID)!;
                const foreign: Task = { ...data.tasks.find(task => task.id === 't-38')!, id: 'x-foreign', projectId: other.id };

                data.tasks.push(foreign);

                const state = new ProjectState(transport, data.projects[0]);

                await state.load();

                expect(await state.readTask('x-foreign')).toBeUndefined();
                expect(state.archivedKnown.has('x-foreign')).toBe(false);
            });

            it('rejects when the daemon cannot be reached, and reads again the next time', async () => {
                const data = createFixtureData();
                const transport = new FixtureTransport({ data });
                let offline = true;
                const state = new ProjectState(overrideTransport(transport, { getTaskDetail: (taskId) => {
                    if (offline) return Promise.reject(new Error('offline'));

                    return transport.getTaskDetail(taskId);
                } }), data.projects[0]);

                await state.load();
                await expect(state.readTask('t-38')).rejects.toThrow('offline');

                offline = false;

                expect((await state.readTask('t-38'))?.key).toBe('CAR-38');
            });
        });

        describe('a key the window does not know', () => {
            /** A project over the fixture daemon, which counts the keys it is asked for; CAR-38 to CAR-40 are archived there, and the window has not seen them. */
            async function readingKeys(overrides: Partial<Transport> = {}) {
                const data = createFixtureData();
                const transport = new FixtureTransport({ data });
                const reads: string[] = [];
                const counted = overrideTransport(transport, {
                    getTaskDetailByKey: (projectId, key) => {
                        reads.push(key);

                        return transport.getTaskDetailByKey(projectId, key);
                    },
                    ...overrides,
                });
                const state = new ProjectState(counted, data.projects[0]);

                await state.load();

                return { data, transport, state, reads };
            }

            const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

            it('answers nothing at once, reads the archived task from the daemon, remembers it, and lets an observer see it', async () => {
                const { state, reads } = await readingKeys();
                const seen: (string | undefined)[] = [];
                const stop = reaction(() => state.taskOfKey('CAR-38')?.key, key => seen.push(key));

                expect(state.taskOfKey('CAR-38')).toBeUndefined();
                expect(reads).toEqual(['CAR-38']);
                expect(seen).toEqual([]);

                await settle();

                expect(seen).toEqual(['CAR-38']);
                expect(state.taskOfKey('CAR-38')).toMatchObject({ id: 't-38', archivedAt: expect.any(Number) });
                expect(state.archivedKnown.has('t-38')).toBe(true);
                // The task is known now: nothing more is asked.
                expect(reads).toEqual(['CAR-38']);
                stop();
            });

            it('makes one read for a key however many times it is asked while the read is on its way', async () => {
                const { state, reads } = await readingKeys();

                for (let call = 0; call < 5; call++) state.taskOfKey('CAR-39');

                state.taskOfKey('CAR-40');

                expect(reads).toEqual(['CAR-39', 'CAR-40']);

                await settle();

                expect(state.taskOfKey('CAR-39')?.id).toBe('t-39');
                expect(state.taskOfKey('CAR-40')?.id).toBe('t-40');
                expect(reads).toEqual(['CAR-39', 'CAR-40']);
            });

            it('asks nothing for a key the window has, or for text that is not a key of this project', async () => {
                const { state, reads } = await readingKeys();

                expect(state.taskOfKey('CAR-24')?.id).toBe('t-24');

                // Another project's prefix, no number, a number with a leading zero or none, a longer key, a path, a sentence, nothing.
                const text = ['CLW-1', 'XYZ-12', 'CAR', 'CAR-', '-38', '38', 'CAR-abc', 'CAR-038', 'CAR-0', 'CAR-1-2', 'CAR-1.5', ' CAR-38', 'src/a.ts', 'npm run build', 'a-b-1', '', '-'];

                for (const key of text) expect(state.taskOfKey(key), key).toBeUndefined();

                expect(reads).toEqual([]);
            });

            it('asks nothing before the project is loaded, when the board is not known yet', async () => {
                const data = createFixtureData();
                const transport = new FixtureTransport({ data });
                const reads: string[] = [];
                const state = new ProjectState(overrideTransport(transport, { getTaskDetailByKey: (_projectId, key) => {
                    reads.push(key);

                    return Promise.reject(new Error('asked too early'));
                } }), data.projects[0]);

                expect(state.taskOfKey('CAR-38')).toBeUndefined();
                expect(reads).toEqual([]);
            });

            it('takes the prefix in any case, and asks once for a key in another case than the task\'s, which stays text', async () => {
                const { state, reads } = await readingKeys();

                expect(state.taskOfKey('car-38')).toBeUndefined();
                await settle();

                // The daemon knows the task, so it is remembered for the key it has; the key as written is not it, and is not asked again.
                expect(reads).toEqual(['car-38']);
                expect(state.archivedKnown.has('t-38')).toBe(true);
                expect(state.taskOfKey('car-38')).toBeUndefined();
                expect(reads).toEqual(['car-38']);
            });

            it('asks once for a key nobody has, and again only after a snapshot is taken in', async () => {
                const { state, transport, reads } = await readingKeys();

                expect(state.taskOfKey('CAR-999')).toBeUndefined();
                await settle();
                expect(state.taskOfKey('CAR-999')).toBeUndefined();
                expect(reads).toEqual(['CAR-999']);

                state.applySnapshot(await transport.getProjectSnapshot(state.id));

                expect(state.taskOfKey('CAR-999')).toBeUndefined();
                expect(reads).toEqual(['CAR-999', 'CAR-999']);
            });

            it('forgets the keys it asked in vain once the daemon has the task, so a restart of the feed finds it', async () => {
                const { data, state, transport, reads } = await readingKeys();
                const later: Task = { ...data.tasks.find(task => task.id === 't-38')!, id: 't-90', key: 'CAR-90', number: 90 };

                state.taskOfKey('CAR-90');
                await settle();
                expect(state.taskOfKey('CAR-90')).toBeUndefined();

                data.tasks.push(later);
                state.applySnapshot(await transport.getProjectSnapshot(state.id));
                state.taskOfKey('CAR-90');
                await settle();

                expect(reads).toEqual(['CAR-90', 'CAR-90']);
                expect(state.taskOfKey('CAR-90')?.id).toBe('t-90');
            });

            it('does not throw or reject when the daemon cannot be reached, asks once, and asks again after a snapshot', async () => {
                const failures: unknown[] = [];
                const onRejection = (reason: unknown) => failures.push(reason);
                let throwing = false;
                const { state, transport, reads } = await readingKeys({
                    getTaskDetailByKey: (_projectId, key) => {
                        reads.push(key);

                        if (throwing) throw new Error('thrown at once');

                        return Promise.reject(new Error('offline'));
                    },
                });

                process.on('unhandledRejection', onRejection);

                try {
                    expect(() => state.taskOfKey('CAR-38')).not.toThrow();
                    await settle();
                    expect(state.taskOfKey('CAR-38')).toBeUndefined();
                    expect(reads).toEqual(['CAR-38']);

                    // A transport that throws before it returns a promise is a failed read as well.
                    throwing = true;
                    state.applySnapshot(await transport.getProjectSnapshot(state.id));
                    expect(() => state.taskOfKey('CAR-38')).not.toThrow();
                    await settle();
                    expect(state.taskOfKey('CAR-38')).toBeUndefined();
                    expect(reads).toEqual(['CAR-38', 'CAR-38']);
                    await settle();
                    expect(failures).toEqual([]);
                }
                finally {
                    process.off('unhandledRejection', onRejection);
                }
            });

            it('leaves a task that is not archived to the board, which its event brings in, and does not ask for it again', async () => {
                const { data, state, reads } = await readingKeys();
                const made: Task = { ...data.tasks.find(task => task.id === 't-24')!, id: 't-91', key: 'CAR-91', number: 91 };

                data.tasks.push(made);

                expect(state.taskOfKey('CAR-91')).toBeUndefined();
                await settle();

                expect(state.archivedKnown.size).toBe(0);
                expect(state.taskOfKey('CAR-91')).toBeUndefined();
                expect(reads).toEqual(['CAR-91']);

                state.applyEvent(event(1001, { type: 'task.upserted', task: made }));

                expect(state.taskOfKey('CAR-91')?.id).toBe('t-91');
                expect(state.archivedKnown.size).toBe(0);
            });

            it('does not remember a task of another project', async () => {
                const { data, state, reads } = await readingKeys({
                    getTaskDetailByKey: async (_projectId, key) => {
                        const task = { ...data.tasks.find(candidate => candidate.id === 't-38')!, projectId: 'p-other' };

                        reads.push(key);

                        return { taskId: task.id, task, chatIds: [], runIds: [], artifacts: [] };
                    },
                });

                state.taskOfKey('CAR-38');
                await settle();

                expect(state.archivedKnown.size).toBe(0);
                expect(state.taskOfKey('CAR-38')).toBeUndefined();
                expect(reads).toEqual(['CAR-38']);
            });

            it('remembers at most UNRESOLVED_KEYS_LIMIT keys it asked in vain, the ones asked longest ago going first', async () => {
                const { state, reads } = await readingKeys();
                const keys = Array.from({ length: UNRESOLVED_KEYS_LIMIT + 1 }, (_, index) => `CAR-${ 1000 + index }`);

                keys.forEach(key => state.taskOfKey(key));
                await settle();
                expect(reads).toHaveLength(keys.length);

                // The newest are held back, the first of them has been let go and is asked once more.
                state.taskOfKey(keys.at(-1)!);
                state.taskOfKey(keys[1]);
                expect(reads).toHaveLength(keys.length);

                state.taskOfKey(keys[0]);
                expect(reads).toHaveLength(keys.length + 1);
                expect(reads.at(-1)).toBe(keys[0]);
            });
        });
    });

    describe('comment revisions', () => {
        const comment = (taskId: string): TaskComment => ({ id: 'cmt_X', taskId, author: { kind: 'user' }, body: 'Hello', createdAt: 1 });

        it('counts the changes to the comments of each task apart: an added, an edited and a deleted comment', async () => {
            const { state } = await loadedProject();
            const before = [state.commentsRevision('t-24'), state.commentsRevision('t-25')];

            state.applyEvent(event(1001, { type: 'task.comment.upserted', comment: comment('t-24') }));
            expect(state.commentsRevision('t-24')).toBe(before[0] + 1);
            expect(state.commentsRevision('t-25')).toBe(before[1]);

            state.applyEvent(event(1002, { type: 'task.comment.upserted', comment: { ...comment('t-24'), body: 'Edited', editedAt: 2 } }));
            state.applyEvent(event(1003, { type: 'task.comment.deleted', taskId: 't-24', commentId: 'cmt_X' }));
            expect(state.commentsRevision('t-24')).toBe(before[0] + 3);
            expect(state.commentsRevision('t-25')).toBe(before[1]);
        });

        it('counts a deleted task too, because its comments are gone with it', async () => {
            const { state } = await loadedProject();
            const before = state.commentsRevision('t-25');

            state.applyEvent(event(1001, { type: 'task.deleted', taskId: 't-25' }));

            expect(state.commentsRevision('t-25')).toBe(before + 1);
        });

        it('does not count an event the snapshot already holds', async () => {
            const { state } = await loadedProject();
            const before = state.commentsRevision('t-24');

            state.applyEvent(event(1000, { type: 'task.comment.upserted', comment: comment('t-24') }));

            expect(state.commentsRevision('t-24')).toBe(before);
        });

        it('changes for every task when a snapshot is taken in again, since the feed may have missed comment events meanwhile', async () => {
            const { state, transport } = await loadedProject();
            const before = [state.commentsRevision('t-24'), state.commentsRevision('t-99')];

            state.applySnapshot(await transport.getProjectSnapshot(state.id));

            expect(state.commentsRevision('t-24')).toBeGreaterThan(before[0]);
            expect(state.commentsRevision('t-99')).toBeGreaterThan(before[1]);
        });

        it('is observable: a reaction on the revision of a task runs for that task\'s comment events only', async () => {
            const { state } = await loadedProject();
            const seen: number[] = [];
            const stop = reaction(() => state.commentsRevision('t-24'), revision => seen.push(revision));

            state.applyEvent(event(1001, { type: 'task.comment.upserted', comment: comment('t-25') }));
            expect(seen).toEqual([]);

            state.applyEvent(event(1002, { type: 'task.comment.upserted', comment: comment('t-24') }));
            expect(seen).toHaveLength(1);
            stop();
        });
    });

    it('drops a deleted chat with its runs and their task links, and keeps the tasks', async () => {
        const { state } = await loadedProject();
        const chat = state.chats.get('c-1')!;
        const runIds = [...state.runs.values()].filter(run => run.chatId === 'c-1' || run.rootRunId === chat.orchestratorRunId).map(run => run.id);

        expect(runIds.length).toBeGreaterThan(1);
        expect(state.tasksOfChat('c-1').length).toBeGreaterThan(0);

        state.applyEvent(event(1001, { type: 'chat.deleted', chatId: 'c-1', runIds }));

        expect(state.chats.has('c-1')).toBe(false);
        expect(runIds.some(runId => state.runs.has(runId))).toBe(false);
        expect(state.tasksOfChat('c-1')).toEqual([]);
        expect(runIds.flatMap(runId => state.linksOfRun(runId))).toEqual([]);
        expect(state.tasks.has('t-24')).toBe(true);
        expect(state.chats.size).toBe(10);
    });

    it('drops the sub-agent runs a truncation removed, with their links, and leaves the run whose stream was cut', async () => {
        const { state } = await loadedProject();
        const runIds = [...state.runs.values()].filter(run => run.parentRunId !== undefined).slice(0, 2).map(run => run.id);
        const orchestrator = 'r-orch-1';

        expect(runIds).toHaveLength(2);

        runIds.forEach((runId, index) => state.applyEvent(event(1001 + index, { type: 'link.runTask', link: { runId, taskId: 't-24', relation: 'created' }, present: true })));
        expect(runIds.flatMap(runId => state.linksOfRun(runId))).toHaveLength(2);

        state.applyEvent(event(1003, { type: 'stream.truncated', runId: orchestrator, fromSeq: 4, removedRunIds: runIds }));

        expect(runIds.some(runId => state.runs.has(runId))).toBe(false);
        expect(runIds.flatMap(runId => state.linksOfRun(runId))).toEqual([]);
        expect(state.runs.has(orchestrator)).toBe(true);
        expect(state.cursor).toBe(1003);
    });

    it('knows the threads of each chat, oldest first, archived ones too, and every thread below a chat at any depth', async () => {
        const { state } = await loadedProject();

        expect(state.threadsOf('c-6').map(chat => chat.id)).toEqual(['c-6a', 'c-6b', 'c-6c', 'c-6e']);
        expect(state.threadsOf('c-6a').map(chat => chat.id)).toEqual(['c-6a1']);
        expect(state.threadsOf('c-1')).toEqual([]);
        expect(state.threadsBelow('c-6').map(chat => chat.id)).toEqual(['c-6a', 'c-6b', 'c-6c', 'c-6e', 'c-6a1']);
        expect(state.threadsBelow('c-6a1')).toEqual([]);

        state.applyEvent(event(1001, { type: 'chat.upserted', chat: { ...state.chats.get('c-6b')!, archivedAt: 5 } }));

        expect(state.threadsOf('c-6').map(chat => chat.id)).toEqual(['c-6a', 'c-6b', 'c-6c', 'c-6e']);
    });

    it('adds and removes links by event', async () => {
        const { state } = await loadedProject();
        const link = { chatId: 'c-4', taskId: 't-28' };

        state.applyEvent(event(1001, { type: 'link.chatTask', link, present: true }));
        expect(state.tasksOfChat('c-4').map(task => task.key)).toEqual(['CAR-28']);
        expect(state.chatsOfTask('t-28').map(chat => chat.id).sort()).toEqual(['c-2', 'c-4']);

        state.applyEvent(event(1002, { type: 'link.chatTask', link, present: false }));
        expect(state.tasksOfChat('c-4')).toEqual([]);
    });

    it('answers many-to-many questions: tasks of a run, runs of a task', async () => {
        const { state } = await loadedProject();

        // One run on several tasks: the ones its orchestrator created and works on.
        expect(state.tasksOfRun('r-orch-1').map(task => task.key)).toEqual(['CAR-21', 'CAR-24', 'CAR-25']);
        // Two runs on one task: the orchestrator that created it and works on it, and another chat's orchestrator assigned to it.
        expect(state.runsOfTask('t-24').map(run => run.name)).toEqual(['Orchestrator 01', 'Orchestrator 05']);
        expect(state.linksOfRun('r-orch-5')).toEqual([{ runId: 'r-orch-5', taskId: 't-24', relation: 'assigned' }]);
        expect(state.runsOfTask('t-999')).toEqual([]);
    });

    it('does not list a run twice when it is linked to one task under two relations', async () => {
        const { state } = await loadedProject();

        state.applyEvent(event(1001, { type: 'link.runTask', link: { runId: 'r-orch-5', taskId: 't-24', relation: 'created' }, present: true }));

        expect(state.runsOfTask('t-24').filter(run => run.id === 'r-orch-5')).toHaveLength(1);
        expect(state.linksOfRun('r-orch-5')).toHaveLength(2);
    });

    it('groups tasks by status in workflow order, with empty columns kept', async () => {
        const { state } = await loadedProject();
        const columns = [...state.tasksByStatus].map(([statusId, tasks]) => [statusId, tasks.map(task => task.number)]);

        expect(columns).toEqual([
            ['backlog', [28, 30]],
            ['todo', [26, 27, 34, 35]],
            ['active', [24, 25, 31, 32]],
            ['review', [23, 36]],
            ['done', [20, 21, 22, 33]],
            ['canceled', [29, 37]],
        ]);

        const task = { ...state.tasks.get('t-24')!, statusId: 'review' };

        state.applyEvent(event(1001, { type: 'task.upserted', task }));
        expect(state.tasksByStatus.get('review')?.map(candidate => candidate.number)).toEqual([23, 24, 36]);
    });

    it('follows run upserts', async () => {
        const { state } = await loadedProject();
        const finished: Run = { ...state.runs.get('r-na-03')!, status: 'succeeded' };

        state.applyEvent(event(1001, { type: 'run.upserted', run: finished }));

        expect(state.runs.get('r-na-03')?.status).toBe('succeeded');
    });

    it('notes artifacts for the screens that show them, and takes a docs change in without keeping it', async () => {
        const { state } = await loadedProject();

        state.applyEvent(event(1001, { type: 'docs.changed', folderId: 'fld_car_rental', path: 'decisions/pricing.md', change: 'modified' }));
        state.applyEvent(event(1002, { type: 'artifact.added', artifact: { id: 'a', projectId: FIXTURE_PROJECT_ID, kind: 'diff', title: 'Diff', ref: {}, createdAt: 0 } }));

        expect(state).not.toHaveProperty('lastDocsChange');
        expect(state.cursor).toBe(1002);
        expect(state.artifactsRevision).toBe(1);
    });

    it('records a failed load and ignores events until a load succeeds', async () => {
        const data = createFixtureData();
        const transport = new FixtureTransport({ data });
        const state = new ProjectState(overrideTransport(transport, { getProjectSnapshot: () => Promise.reject(new Error('offline')) }), data.projects[0]);

        expect(await state.load()).toBe(false);
        expect(state.status).toBe('failed');
        expect(state.error).toBe('offline');

        state.applyEvent(event(1001, { type: 'task.upserted', task: data.tasks[0] }));
        expect(state.tasks.size).toBe(0);
    });
});
