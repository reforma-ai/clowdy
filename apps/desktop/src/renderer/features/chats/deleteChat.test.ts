import { describe, expect, it, vi } from 'vitest';

import { deleteMessage } from './deleteChat';

// `Modal` cannot load under the desktop's Vitest (decorators); only the words are checked here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));

describe('deleteMessage', () => {
    it('names the chat and the runs of its agents when it has no threads', () => {
        expect(deleteMessage({ title: 'Fix login' }, 0)).toBe('"Fix login" and the runs of its agents are deleted for good. The tasks it made stay.');
    });

    it('says how many threads go with the chat', () => {
        expect(deleteMessage({ title: 'Ship it' }, 1)).toBe('"Ship it", its thread and the runs of their agents are deleted for good. The tasks they made stay.');
        expect(deleteMessage({ title: 'Ship it' }, 5)).toBe('"Ship it", its 5 threads and the runs of their agents are deleted for good. The tasks they made stay.');
    });
});
