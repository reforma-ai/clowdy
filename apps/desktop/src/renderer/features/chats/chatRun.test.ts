import { describe, expect, it } from 'vitest';

import { isRunActive, isRunBusy, liveLine } from './chatRun';

import type { Run, RunStatus } from '@clowdy/protocol';

const run = (status: RunStatus): Run => ({
    id: 'r',
    projectId: 'p',
    rootRunId: 'r',
    role: 'orchestrator',
    name: 'Orchestrator 01',
    summary: '',
    status,
    engine: 'fake',
    createdAt: 0,
});

describe('isRunActive', () => {
    it('is true for every status that has not ended', () => {
        for (const status of ['queued', 'running', 'waiting_background', 'waiting_user', 'blocked'] as const) {
            expect(isRunActive(run(status)), status).toBe(true);
        }
    });

    it('is false for a finished run and for no run', () => {
        for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
            expect(isRunActive(run(status)), status).toBe(false);
        }

        expect(isRunActive(undefined)).toBe(false);
    });
});

describe('isRunBusy', () => {
    it('is true while a message to the orchestrator waits for it', () => {
        for (const status of ['queued', 'running', 'waiting_user', 'blocked'] as const) {
            expect(isRunBusy(run(status)), status).toBe(true);
        }
    });

    it('is false while it only waits for background work, which takes a message at once, and once it has ended', () => {
        for (const status of ['waiting_background', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
            expect(isRunBusy(run(status)), status).toBe(false);
        }

        expect(isRunBusy(undefined)).toBe(false);
    });
});

describe('liveLine', () => {
    it('shows the default line while working and names what a queued run waits for', () => {
        expect(liveLine('running')).toBe(true);
        expect(liveLine('queued')).toMatch(/free slot/);
    });

    it('shows no line when the run waits for the person (its question is in the stream), waits for background work, is blocked, or has ended', () => {
        for (const status of ['waiting_user', 'waiting_background', 'blocked', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
            expect(liveLine(status), status).toBe(false);
        }
    });
});
