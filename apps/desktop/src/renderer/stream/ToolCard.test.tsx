// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolCard } from './ToolCard';

import type { StreamItemBody } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = Extract<StreamItemBody, { kind: 'tool' }>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    // Opening a call animates its height; with reduced motion asked for, it does not, which is all this environment can run.
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined })) as unknown as typeof window.matchMedia;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const call = (fields: Partial<Call> = {}): Call => ({ kind: 'tool', toolCallId: 't1', name: 'Read', input: { file_path: 'src/form.tsx' }, state: 'done', output: 'export {}', ...fields });
const draw = (fields?: Partial<Call>) => act(async () => root.render(<ToolCard call={ call(fields) } />));
const header = () => container.querySelector<HTMLElement>('button')!;

describe('ToolCard', () => {
    it('shows what the call does and the file it works on', async () => {
        await draw();

        expect(header().textContent).toContain('Reading file');
        expect(header().textContent).toContain('src/form.tsx');
    });

    it('keeps input and output away until the line is opened', async () => {
        await draw();

        expect(container.textContent).not.toContain('export {}');

        await act(async () => header().click());

        expect(container.textContent).toContain('Input');
        expect(container.textContent).toContain('Output');
        expect(container.textContent).toContain('export {}');
    });

    it('strikes the title through when the call failed, and shows the error once opened', async () => {
        await draw({ state: 'error', error: 'No such file' });

        expect(header().innerHTML).toContain('line-through');

        await act(async () => header().click());

        expect(container.textContent).toContain('No such file');
    });

    it('shimmers the title while the call runs', async () => {
        await draw({ state: 'running', output: undefined });

        expect(header().innerHTML).toMatch(/shimmer/i);
    });
});
