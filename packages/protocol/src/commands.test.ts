import { describe, expect, test } from 'vitest';

import { MAX_ATTACHMENTS_PER_MESSAGE } from './api';
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
