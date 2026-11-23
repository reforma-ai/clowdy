// @vitest-environment happy-dom
import { STOPPED_TOOL } from '@clowdy/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CompactionLine } from './CompactionLine';
import { compactionCounts } from './compaction';

import type { StreamItemBody } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = Extract<StreamItemBody, { kind: 'tool' }>;

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

const facts = { trigger: 'manual', preTokens: 22_062, postTokens: 6_111, durationMs: 4_200 };
const call = (fields: Partial<Call> = {}): Call => ({
    kind: 'tool',
    toolCallId: 'k1',
    name: 'compact',
    input: { title: 'Compact conversation' },
    state: 'done',
    ...fields,
});
const draw = (fields: Partial<Call> = {}, active = true) =>
    act(async () => root.render(<CompactionLine call={call(fields)} active={active} />));
const line = () => container.querySelector<HTMLElement>('[role="status"]')!;

describe('CompactionLine', () => {
    it('shimmers "Compacting context" while the agent compacts', async () => {
        await draw({ state: 'running' });

        expect(line().textContent).toBe('Compacting context');
        // The words sit in the shimmer's own element inside the line's text.
        expect(line().querySelector('span span')?.textContent).toBe('Compacting context');
    });

    it('says what the compaction saved when the agent reported it, as JSON text or as an object', async () => {
        await draw({ output: JSON.stringify(facts) });

        expect(line().textContent).toBe('Context compacted · 22.1K → 6.1K');

        await draw({ output: { ...facts, preTokens: 1_200_000, postTokens: 940 } });

        expect(line().textContent).toBe('Context compacted · 1.2M → 940');
    });

    it('says only that it compacted when there are no counts, as for Codex', async () => {
        await draw({ output: undefined });

        expect(line().textContent).toBe('Context compacted');
    });

    it('says the compaction failed, in the danger tone', async () => {
        await draw({ state: 'error', error: 'Compaction failed: the summary was empty' });

        expect(line().textContent).toBe('Compaction failed');
        expect(line().className).toMatch(/failed/);
    });

    it('says a compaction the person stopped was stopped, without the danger tone', async () => {
        await draw({ state: 'error', error: STOPPED_TOOL });

        expect(line().textContent).toBe('Compaction stopped');
        expect(line().className).not.toMatch(/failed/);
    });

    it('does not shimmer for a call left running in a run that is over', async () => {
        await draw({ state: 'running' }, false);

        expect(line().textContent).toBe('Compaction did not finish');
    });
});

describe('compactionCounts', () => {
    it("reads the tokens before and after from the call's output", () => {
        expect(compactionCounts(facts)).toEqual({ before: 22_062, after: 6_111 });
        expect(compactionCounts(JSON.stringify(facts))).toEqual({ before: 22_062, after: 6_111 });
    });

    it('finds none in an output without them, or one that is not what Claude reports', () => {
        expect(compactionCounts(undefined)).toBeUndefined();
        expect(compactionCounts('Compaction failed: the summary was empty')).toBeUndefined();
        expect(compactionCounts({ preTokens: 10 })).toBeUndefined();
        expect(compactionCounts({ preTokens: '10', postTokens: 5 })).toBeUndefined();
        expect(compactionCounts({ preTokens: -1, postTokens: 5 })).toBeUndefined();
        expect(compactionCounts([facts])).toBeUndefined();
    });
});
