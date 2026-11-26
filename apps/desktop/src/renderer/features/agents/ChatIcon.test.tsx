import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChatStatus } from './ChatIcon';

import type { BackgroundItem, Run } from '@clowdy/protocol';

const run = (background?: BackgroundItem[]): Run => ({
    id: 'run',
    projectId: 'project',
    rootRunId: 'run',
    role: 'orchestrator',
    name: 'Agent',
    summary: 'Agent',
    status: 'waiting_background',
    engine: 'fake',
    createdAt: 1,
    background,
});

describe('chat activity status', () => {
    it.each(['command', 'task', 'subagent'] as const)('shows background work for a %s', kind => {
        const markup = renderToStaticMarkup(<ChatStatus run={run([{ id: 'item', kind, title: 'Work' }])} />);

        expect(markup).toContain('aria-label="Waiting for background work"');
        expect(markup).toContain('<svg');
    });

    it('shows background work even before its details arrive', () => {
        const markup = renderToStaticMarkup(<ChatStatus run={run()} />);

        expect(markup).toContain('aria-label="Waiting for background work"');
        expect(markup).toContain('<svg');
    });

    it('gives a question for the user priority over background work', () => {
        const markup = renderToStaticMarkup(<ChatStatus run={{ ...run(), awaitingUser: true }} />);

        expect(markup).toContain('aria-label="Waiting"');
        expect(markup).toContain('data-tone="accent"');
    });

    it('keeps the working indicator when the agent is answering', () => {
        const markup = renderToStaticMarkup(<ChatStatus run={{ ...run(), status: 'running' }} />);

        expect(markup).toContain('aria-label="Working"');
        expect(markup).toContain('data-live="true"');
    });
});
