import { describe, expect, test } from 'vitest';

import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_BASE_BRANCH_LENGTH, MAX_SETUP_COMMAND_LENGTH, MAX_SETUP_FILES } from './api';
import { commandSchema } from './commands';

const base = { requestId: 'req-00000001' };

describe('chat.edit', () => {
    test('takes the chat, the message and the new text, with files when the message carries any', () => {
        expect(commandSchema.safeParse({ ...base, type: 'chat.edit', chatId: 'c1', itemId: 'i1', text: 'again' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'chat.edit', chatId: 'c1', itemId: 'i1', text: '', attachmentIds: ['a1'] }).success).toBe(true);
    });

    test('needs the message to name, and at most as many files as a message may carry', () => {
        expect(commandSchema.safeParse({ ...base, type: 'chat.edit', chatId: 'c1', text: 'again' }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'chat.edit', chatId: 'c1', itemId: 'i1' }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'chat.edit', chatId: 'c1', itemId: 'i1', text: 'x', attachmentIds: Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, index) => `a${ index }`) }).success).toBe(false);
    });
});

describe('task.create and task.update', () => {
    test('task.create takes the parent as an id', () => {
        expect(commandSchema.safeParse({ ...base, type: 'task.create', projectId: 'p1', title: 'Stage 1', parentId: 't1' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.create', projectId: 'p1', title: 'Stage 1' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.create', projectId: 'p1', title: 'Stage 1', parentId: null }).success).toBe(false);
    });

    test('task.update moves a task under a parent with an id and makes it a root again with null', () => {
        expect(commandSchema.safeParse({ ...base, type: 'task.update', taskId: 't2', parentId: 't1' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.update', taskId: 't2', parentId: null }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.update', taskId: 't2' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.update', taskId: 't2', parentId: 3 }).success).toBe(false);
    });

    test('the parent survives parsing, and null stays null (it is not the same as leaving it out)', () => {
        const moved = commandSchema.parse({ ...base, type: 'task.update', taskId: 't2', parentId: null });
        const left = commandSchema.parse({ ...base, type: 'task.update', taskId: 't2' });

        expect('parentId' in moved && moved.parentId).toBeNull();
        expect('parentId' in left).toBe(false);
    });
});

describe('task comments', () => {
    test('task.comment.add takes the task and the Markdown body, and nothing else is needed (the author is the person)', () => {
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.add', taskId: 't1', body: '**Found it**' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.add', taskId: 't1' }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.add', body: 'x' }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.add', taskId: 't1', body: 3 }).success).toBe(false);
        // An empty body is the daemon's refusal, with its own message: the schema lets it through.
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.add', taskId: 't1', body: '' }).success).toBe(true);
    });

    test('task.comment.edit and task.comment.delete name the task and the comment', () => {
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.edit', taskId: 't1', commentId: 'c1', body: 'Better' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.edit', taskId: 't1', commentId: 'c1' }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.edit', taskId: 't1', body: 'Better' }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.delete', taskId: 't1', commentId: 'c1' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.delete', commentId: 'c1' }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'task.comment.delete', taskId: 't1' }).success).toBe(false);
    });

    test('a client cannot name the author: a field that is not part of the command is dropped on parsing', () => {
        const parsed = commandSchema.parse({ ...base, type: 'task.comment.add', taskId: 't1', body: 'x', author: { kind: 'run', runId: 'r1' } });

        expect(parsed).not.toHaveProperty('author');
        expect(parsed).toMatchObject({ taskId: 't1', body: 'x' });
    });
});

describe('task.archive and task.unarchive', () => {
    test('task.archive takes the task, and cancel only when the person wants open work closed with it', () => {
        expect(commandSchema.safeParse({ ...base, type: 'task.archive', taskId: 't1' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.archive', taskId: 't1', cancel: true }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.archive', taskId: 't1', cancel: false }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.archive' }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'task.archive', taskId: 't1', cancel: 'yes' }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'task.archive', taskId: ['t1'] }).success).toBe(false);
    });

    test('task.unarchive takes the task and nothing else', () => {
        expect(commandSchema.safeParse({ ...base, type: 'task.unarchive', taskId: 't1' }).success).toBe(true);
        expect(commandSchema.safeParse({ ...base, type: 'task.unarchive' }).success).toBe(false);
        // What it restores is the batch of the task, not something a client picks: a field that is not part of the command is dropped on parsing.
        expect(commandSchema.parse({ ...base, type: 'task.unarchive', taskId: 't1', cancel: true })).not.toHaveProperty('cancel');
    });
});

describe('project.updateFolder', () => {
    const update = (settings: unknown) => ({ ...base, type: 'project.updateFolder', projectId: 'p1', folderId: 'f1', settings });

    test('takes a base branch and a setup, each of which may be cleared with null or left out', () => {
        expect(commandSchema.safeParse(update({ baseBranch: 'origin/next', setup: { files: ['.env', '.env*'], command: 'bun install' } })).success).toBe(true);
        expect(commandSchema.safeParse(update({ baseBranch: null, setup: null })).success).toBe(true);
        expect(commandSchema.safeParse(update({ setup: { files: [] } })).success).toBe(true);
        expect(commandSchema.safeParse(update({})).success).toBe(true);
    });

    test('needs the project, the folder and the settings', () => {
        expect(commandSchema.safeParse({ ...base, type: 'project.updateFolder', folderId: 'f1', settings: {} }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'project.updateFolder', projectId: 'p1', settings: {} }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'project.updateFolder', projectId: 'p1', folderId: '', settings: {} }).success).toBe(false);
        expect(commandSchema.safeParse({ ...base, type: 'project.updateFolder', projectId: 'p1', folderId: 'f1' }).success).toBe(false);
    });

    test('holds the limits: a branch name, the number of files and the length of a command', () => {
        expect(commandSchema.safeParse(update({ baseBranch: '' })).success).toBe(false);
        expect(commandSchema.safeParse(update({ baseBranch: 'b'.repeat(MAX_BASE_BRANCH_LENGTH) })).success).toBe(true);
        expect(commandSchema.safeParse(update({ baseBranch: 'b'.repeat(MAX_BASE_BRANCH_LENGTH + 1) })).success).toBe(false);
        expect(commandSchema.safeParse(update({ setup: { files: Array.from({ length: MAX_SETUP_FILES }, (_, index) => `f${ index }`) } })).success).toBe(true);
        expect(commandSchema.safeParse(update({ setup: { files: Array.from({ length: MAX_SETUP_FILES + 1 }, (_, index) => `f${ index }`) } })).success).toBe(false);
        expect(commandSchema.safeParse(update({ setup: { files: [''] } })).success).toBe(false);
        expect(commandSchema.safeParse(update({ setup: { files: [], command: 'x'.repeat(MAX_SETUP_COMMAND_LENGTH) } })).success).toBe(true);
        expect(commandSchema.safeParse(update({ setup: { files: [], command: 'x'.repeat(MAX_SETUP_COMMAND_LENGTH + 1) } })).success).toBe(false);
    });

    test('the files are a list of strings, and a setup has to name them', () => {
        expect(commandSchema.safeParse(update({ setup: { command: 'bun install' } })).success).toBe(false);
        expect(commandSchema.safeParse(update({ setup: { files: '.env' } })).success).toBe(false);
        expect(commandSchema.safeParse(update({ baseBranch: 3 })).success).toBe(false);
    });
});
