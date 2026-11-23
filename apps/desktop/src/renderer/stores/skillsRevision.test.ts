import { describe, expect, it } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { RootStore } from './RootStore';

describe('RootStore skills', () => {
    it('counts skills.changed events from any project, so the Skills settings refetch', () => {
        const root = new RootStore(new FixtureTransport(), {
            storage: { getItem: () => null, setItem: () => undefined },
        });

        expect(root.skillsRevision).toBe(0);

        root.handleEvent({ cursor: 1, at: 0, projectId: 'p-car', data: { type: 'skills.changed' } });
        root.handleEvent({ cursor: 2, at: 0, projectId: 'unknown', data: { type: 'skills.changed' } });
        root.handleEvent({ cursor: 3, at: 0, projectId: 'p-car', data: { type: 'notice', level: 'info', text: 'x' } });

        expect(root.skillsRevision).toBe(2);
    });
});
