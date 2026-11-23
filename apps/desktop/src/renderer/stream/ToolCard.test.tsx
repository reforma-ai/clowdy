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
    window.matchMedia = ((query: string) => ({
        matches: query.includes('reduce'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const call = (fields: Partial<Call> = {}): Call => ({
    kind: 'tool',
    toolCallId: 't1',
    name: 'Read',
    input: { file_path: 'src/form.tsx' },
    state: 'done',
    output: 'export {}',
    ...fields,
});
const draw = (fields?: Partial<Call>) => act(async () => root.render(<ToolCard call={call(fields)} />));
const header = () => container.querySelector<HTMLElement>('button')!;

describe('ToolCard', () => {
    it('shows what the call does and the file it works on', async () => {
        await draw();

        expect(header().textContent).toContain('Reading file');
        expect(header().textContent).toContain('src/form.tsx');
    });

    it('titles a command by what the agent says it does, with the command beside it', async () => {
        await draw({
            name: 'Bash',
            input: { command: 'bun install', description: 'Install package dependencies' },
            output: 'done',
        });

        expect(header().textContent).toContain('Install package dependencies');
        expect(header().querySelector('code')?.textContent).toBe('bun install');
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

    describe("the step that makes the chat's worktree", () => {
        const step = (fields: Partial<Call> = {}): Partial<Call> => ({
            name: 'workspace',
            input: { path: '/work/api', branch: 'clowdy/ab12cd34', base: 'origin/main' },
            output: "Fetching origin/main\nPreparing worktree (new branch 'clowdy/ab12cd34')",
            ...fields,
        });

        it('is Preparing workspace while it runs, with the branch as its chip, and Prepared workspace when it is over', async () => {
            await draw(step({ state: 'running', output: undefined }));

            expect(header().textContent).toContain('Preparing workspace');
            expect(header().querySelector('code')?.textContent).toBe('clowdy/ab12cd34');
            expect(header().innerHTML).toMatch(/shimmer/i);

            await draw(step());

            expect(header().textContent).toContain('Prepared workspace');
            expect(header().innerHTML).not.toMatch(/shimmer/i);
        });

        it('folds its log under it, with no input to show', async () => {
            await draw(step());

            expect(container.textContent).not.toContain('Fetching origin/main');

            await act(async () => header().click());

            expect(container.textContent).toContain('Log');
            expect(container.textContent).toContain('Fetching origin/main');
            expect(container.textContent).toContain('Preparing worktree');
            expect(container.textContent).not.toContain('Input');
            expect(container.textContent).not.toContain('Output');
        });

        it('shows the reason it failed, struck through on the title and in full once opened', async () => {
            await draw(
                step({ state: 'error', error: "'clowdy/ab12cd34' is already used by worktree at '/work/other'" })
            );

            expect(header().textContent).toContain('Prepare workspace');
            expect(header().innerHTML).toContain('line-through');

            await act(async () => header().click());

            expect(container.textContent).toContain('Error');
            expect(container.textContent).toContain('is already used by worktree');
        });
    });
});
