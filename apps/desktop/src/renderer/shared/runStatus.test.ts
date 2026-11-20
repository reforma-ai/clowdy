import { describe, expect, it } from 'vitest';

import { RUN_STATUS_VIEW } from './runStatus';

describe('RUN_STATUS_VIEW', () => {
    it('names the wait for background work apart from the other waits, and keeps it calm', () => {
        expect(RUN_STATUS_VIEW.waiting_background).toEqual({ label: 'Background', tone: 'success' });

        for (const status of ['waiting_children', 'waiting_user'] as const) {
            expect(RUN_STATUS_VIEW[status].label, status).toBe('Waiting');
        }
    });

    it('has a label for every status, with no period at the end of a phrase', () => {
        for (const [status, view] of Object.entries(RUN_STATUS_VIEW)) {
            expect(view.label, status).not.toBe('');
            expect(view.label, status).not.toMatch(/\.$/);
        }
    });
});
