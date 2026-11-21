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
