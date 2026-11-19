// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StreamView } from './StreamView';

import type { StreamItem, StreamItemBody } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const item = (n: number, body: StreamItemBody): StreamItem => ({ id: `i-${ n }`, runId: 'r', seq: n, at: n * 20_000, body });
const items = [
    item(0, { kind: 'user', text: 'Fix the form' }),
    item(1, { kind: 'assistant', text: 'Looking at it.', done: true }),
    item(2, { kind: 'tool', toolCallId: 't1', name: 'Read', input: { file_path: 'src/form.tsx' }, state: 'done' }),
    item(3, { kind: 'assistant', text: 'The form is fixed.', done: true }),
];

const draw = (props: { active?: boolean; working?: boolean }) => act(async () => root.render(<StreamView items={ items } { ...props } />));
const worked = () => [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Worked for'));

describe('StreamView', () => {
    it('folds the work of a finished turn under one line, and keeps the message and the answer', async () => {
        await draw({ active: false });

        expect(worked()?.textContent).toBe('Worked for 1m');
        expect(container.textContent).toContain('Fix the form');
        expect(container.textContent).toContain('The form is fixed.');
        expect(container.textContent).not.toContain('Looking at it.');
        expect(container.textContent).not.toContain('src/form.tsx');
    });

    it('shows the work when the line is opened', async () => {
        await draw({ active: false });
        await act(async () => worked()!.click());

        expect(container.textContent).toContain('Looking at it.');
        expect(container.textContent).toContain('src/form.tsx');
    });

    it('draws a compaction as its own line, not as a tool line, after the answer it followed', async () => {
        const compact = item(4, { kind: 'tool', toolCallId: 'k1', name: 'compact', input: { title: 'Compact conversation' }, state: 'done', output: JSON.stringify({ preTokens: 22_062, postTokens: 6_111 }) });

        await act(async () => root.render(<StreamView items={ [...items, compact] } active={ false } />));

        expect(container.textContent).toContain('Context compacted · 22.1K → 6.1K');
        // A tool line would read the humanized name with the title as its chip.
        expect(container.textContent).not.toContain('Compact conversation');
    });

    it('ends on the compaction alone while it runs, without the working line under it', async () => {
        const compacting = item(4, { kind: 'tool', toolCallId: 'k1', name: 'compact', input: { title: 'Compact conversation' }, state: 'running' });

        await act(async () => root.render(<StreamView items={ [...items, compacting] } active working />));

        expect(container.textContent).toContain('Compacting context');
        expect(container.textContent).not.toContain('Working…');

        await act(async () => root.render(<StreamView items={ [...items, { ...compacting, body: { ...compacting.body, state: 'done' } as StreamItemBody }] } active working />));

        expect(container.textContent).toContain('Working…');
    });

    it('puts the action it is given at the end of an error', async () => {
        const failed = [...items, item(4, { kind: 'error', text: 'The conversation no longer fits the model\'s context window. Start a new chat.' })];

        await act(async () => root.render(<StreamView items={ failed } errorAction={ entry => (entry.id === 'i-4' ? <button type="button">Compact</button> : null) } />));

        const alert = container.querySelector('[role="alert"]') ?? [...container.querySelectorAll('div')].find(div => div.textContent?.startsWith('The conversation no longer fits'));

        expect(alert?.textContent).toContain('Compact');
    });

    it('shows all of it while the run is going', async () => {
        await draw({ active: true });

        expect(worked()).toBeUndefined();
        expect(container.textContent).toContain('Looking at it.');
        expect(container.textContent).toContain('src/form.tsx');
    });
});
