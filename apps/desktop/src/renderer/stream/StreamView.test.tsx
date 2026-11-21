// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamView, type StreamViewProps } from './StreamView';
import { SWIPE } from './swipeReply';

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

describe('the agent\'s reasoning', () => {
    const thought = (n: number, text: string, done = true, durationMs?: number) => item(n, { kind: 'reasoning', text, done, ...(durationMs !== undefined && { durationMs }) });
    const said = (n: number, text: string, done = true) => item(n, { kind: 'assistant', text, done });
    const bash = (n: number, command: string, state: 'done' | 'running' = 'done') => item(n, { kind: 'tool', toolCallId: `b${ n }`, name: 'Bash', input: { command }, state });
    const asked = item(0, { kind: 'user', text: 'Check the box' });
    const line = (label: string) => [...container.querySelectorAll('button')].find(button => button.textContent === label);

    it('is a line that says how long it took, closed, and a press opens the words', async () => {
        await act(async () => root.render(<StreamView items={ [asked, thought(1, 'The box is the one named in the task.', true, 3200), said(2, 'It is the right one.', false)] } active working />));

        expect(line('Thought 3s')).toBeDefined();
        expect(line('Thought 3s')!.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).not.toContain('named in the task');

        await act(async () => line('Thought 3s')!.click());

        expect(line('Thought 3s')!.getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('The box is the one named in the task.');
    });

    it('says Thinking while it goes on, shimmering, without the Working line under it', async () => {
        await act(async () => root.render(<StreamView items={ [asked, thought(1, 'Let me see', false)] } active working />));

        expect(line('Thinking…')).toBeDefined();
        expect(line('Thinking…')!.querySelector('[style*="shimmer"]')).not.toBeNull();
        expect(container.textContent).not.toContain('Working…');

        await act(async () => root.render(<StreamView items={ [asked, thought(1, 'Let me see', true, 800)] } active working />));

        // Done, and the agent has not gone on yet: the working line is back.
        expect(line('Thought')).toBeDefined();
        expect(container.textContent).toContain('Working…');
    });

    it('stands in the fold of a finished turn with the rest of the work, and the answer stays out', async () => {
        await act(async () => root.render(<StreamView items={ [asked, thought(1, 'First I will check.', true, 2000), said(2, 'Checking.'), bash(3, 'pwd'), bash(4, 'whoami'), said(5, 'All fine.')] } />));

        // Under the fold, so out of sight until it is opened.
        expect(line('Thought 2s')).toBeUndefined();

        await act(async () => worked()!.click());

        expect(line('Thought 2s')).toBeDefined();
        expect(container.textContent).toContain('Checking.');
        expect(container.textContent).toContain('All fine.');
    });

    it('goes in the group of the calls it is between, which counts only the calls', async () => {
        const stream = [asked, bash(1, 'pwd'), thought(2, 'Now the user.', true, 1500), bash(3, 'whoami'), said(4, 'Fine.', false)];

        await act(async () => root.render(<StreamView items={ stream } active working />));

        expect(line('Ran 2 commands')).toBeDefined();
        expect(container.textContent).not.toContain('Thought');

        await act(async () => line('Ran 2 commands')!.click());

        expect(line('Thought 2s')).toBeDefined();
        expect(container.textContent).toContain('pwd');
        expect(container.textContent).toContain('whoami');
    });

    it('is open in the live group while the agent thinks after its calls', async () => {
        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'whoami'), thought(3, 'What next?', false)] } active working />));

        expect(line('Ran 2 commands')!.getAttribute('aria-expanded')).toBe('true');
        expect(line('Thinking…')).toBeDefined();
    });

    it('keeps the line of a group the person closed shimmering while the agent thinks in it, since no Working line stands in for it then', async () => {
        const stream = [asked, bash(1, 'pwd'), bash(2, 'whoami')];

        await act(async () => root.render(<StreamView items={ [...stream, thought(3, 'What next?', false)] } active working />));
        await act(async () => line('Ran 2 commands')!.click());

        expect(line('Ran 2 commands')!.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).not.toContain('Working…');
        expect(line('Ran 2 commands')!.querySelector('[style*="shimmer"]')).not.toBeNull();

        // The thought ends: the line rests and the Working line is back.
        await act(async () => root.render(<StreamView items={ [...stream, thought(3, 'What next?', true, 2000)] } active working />));

        expect(line('Ran 2 commands')!.querySelector('[style*="shimmer"]')).toBeNull();
        expect(container.textContent).toContain('Working…');
    });

    it('leaves a thought and a single call as two rows of the fold, with no group around them', async () => {
        await act(async () => root.render(<StreamView items={ [asked, thought(1, 'One call only.', true, 2000), bash(2, 'pwd'), said(3, 'Done.')] } />));

        expect(line('Thought 2s')).toBeUndefined();

        await act(async () => worked()!.click());

        expect(line('Thought 2s')).toBeDefined();
        expect(container.textContent).toContain('pwd');
        expect([...container.querySelectorAll('button')].some(button => button.textContent?.startsWith('Ran'))).toBe(false);
    });

    it('takes a thought that trails the answer into the fold: no loose line under the answer', async () => {
        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'whoami'), said(3, 'All fine.'), thought(4, 'Anything else?', true, 1000)] } />));

        expect(line('Thought 1s')).toBeUndefined();

        await act(async () => worked()!.click());

        // The group of the two calls holds the thought, since it ends their run.
        expect(line('Ran 2 commands')).toBeDefined();
        expect(container.textContent).not.toContain('Anything else?');
        expect((container.textContent ?? '').indexOf('Worked for')).toBeLessThan((container.textContent ?? '').indexOf('All fine.'));
    });

    it('is one row for thoughts that follow one another: the words together, the time added', async () => {
        await act(async () => root.render(<StreamView items={ [asked, thought(1, 'Reading the form first.', true, 2000), thought(2, 'Then the price helper.', true, 1500), said(3, 'On it.', false)] } active working />));

        expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(1);
        expect(line('Thought 4s')).toBeDefined();

        await act(async () => line('Thought 4s')!.click());

        expect(container.textContent).toContain('Reading the form first.');
        expect(container.textContent).toContain('Then the price helper.');
    });

    it('folds a turn whose only work is a thought, and puts the divider of a fork after the answer that a thought precedes', async () => {
        await act(async () => root.render(<StreamView items={ [asked, thought(1, 'Easy one.', true, 4000), said(2, 'Yes.')] } forkedFrom={ { atSeq: 2, title: 'Check the box' } } />));

        expect(worked()).toBeDefined();
        expect(line('Thought 4s')).toBeUndefined();
        expect(container.querySelector<HTMLElement>('[data-slot="fork-divider"]')?.previousElementSibling?.textContent).toContain('Yes.');
    });
});

describe('runs of tool calls', () => {
    const bash = (n: number, command: string, state: 'done' | 'running' = 'done') => item(n, { kind: 'tool', toolCallId: `b${ n }`, name: 'Bash', input: { command }, state });
    const said = (n: number, text: string, done = true) => item(n, { kind: 'assistant', text, done });
    const group = (label: string) => [...container.querySelectorAll('button')].find(button => button.textContent === label);
    const asked = item(0, { kind: 'user', text: 'Check the box' });

    it('draws calls that follow one another under one line, closed once the agent has gone on, and a press opens them', async () => {
        await act(async () => root.render(<StreamView items={ [asked, said(1, 'Checking.'), bash(2, 'pwd'), bash(3, 'whoami'), said(4, 'Looks fine.', false)] } active />));

        expect(group('Ran 2 commands')).toBeDefined();
        expect(container.textContent).not.toContain('pwd');

        await act(async () => group('Ran 2 commands')!.click());

        expect(container.textContent).toContain('pwd');
        expect(container.textContent).toContain('whoami');
    });

    it('leaves a call alone as it is', async () => {
        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), said(2, 'Fine.', false)] } active />));

        expect(container.textContent).toContain('pwd');
        expect([...container.querySelectorAll('button')].some(button => button.textContent?.startsWith('Ran'))).toBe(false);
    });

    it('keeps the run at the end of a stream that is going open, tells what runs now, and closes it once the agent goes on', async () => {
        const going = [asked, bash(1, 'pwd'), bash(2, 'bun test', 'running')];

        await act(async () => root.render(<StreamView items={ going } active working />));

        expect(group('Running 2 commands')).toBeDefined();
        expect(container.textContent).toContain('bun test');

        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'bun test'), said(3, 'Tests pass.', false)] } active working />));

        expect(group('Ran 2 commands')).toBeDefined();
        expect(container.textContent).not.toContain('bun test');
    });

    it('is closed in a stream that is over, whatever it ends with', async () => {
        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'whoami')] } />));

        expect(group('Ran 2 commands')).toBeDefined();
        expect(container.textContent).not.toContain('whoami');
    });

    it('keeps what the person chose when the run goes on', async () => {
        const stream = (extra: StreamItem[] = []) => [asked, bash(1, 'pwd'), bash(2, 'whoami', 'running'), ...extra];

        await act(async () => root.render(<StreamView items={ stream() } active working />));
        await act(async () => group('Running 2 commands')!.click());

        expect(container.textContent).not.toContain('whoami');

        // A third call joins the group: it stays closed, for the person closed it.
        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'whoami'), bash(3, 'date', 'running')] } active working />));

        expect(group('Running 3 commands')).toBeDefined();
        expect(container.textContent).not.toContain('date');
    });

    it('groups the calls inside the fold of a finished turn, closed', async () => {
        const stream = [asked, said(1, 'Checking.'), bash(2, 'pwd'), bash(3, 'whoami'), said(4, 'All fine.')];

        await act(async () => root.render(<StreamView items={ stream } />));
        await act(async () => worked()!.click());

        expect(container.textContent).toContain('Checking.');
        expect(group('Ran 2 commands')).toBeDefined();
        expect(container.textContent).not.toContain('whoami');

        await act(async () => group('Ran 2 commands')!.click());

        expect(container.textContent).toContain('whoami');
    });

    it('closes the run when the agent stops to ask the person, though the stream is still going', async () => {
        const question = item(3, { kind: 'question', questionId: 'q1', text: 'Which one?', options: [] });

        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'whoami')] } active working />));

        expect(container.textContent).toContain('whoami');

        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'whoami'), question] } active />));

        expect(group('Ran 2 commands')).toBeDefined();
        expect(container.textContent).toContain('Which one?');
        expect(container.textContent).not.toContain('whoami');
    });

    it('closes the run while the stream waits for something other than the agent: background work, a free slot, the person', async () => {
        const stream = [asked, bash(1, 'pwd'), bash(2, 'bun test', 'running')];

        await act(async () => root.render(<StreamView items={ stream } active working />));

        expect(container.textContent).toContain('bun test');

        // Waiting on background work (what `RunDetail` says), a free slot, or a run that is going on without working.
        await act(async () => root.render(<StreamView items={ stream } active working="Waiting for background work…" />));

        expect(container.textContent).not.toContain('bun test');
        expect(group('Running 2 commands')!.getAttribute('aria-expanded')).toBe('false');

        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'bun test')] } active />));

        expect(container.textContent).not.toContain('bun test');
        expect(group('Ran 2 commands')).toBeDefined();
    });

    it('draws two phases with the commentary between them, and only the one at the end open while the agent works', async () => {
        const stream = [asked, bash(1, 'pwd'), bash(2, 'whoami'), said(3, 'That is the right box. Now the build.'), bash(4, 'bun run build'), bash(5, 'bun test', 'running')];

        await act(async () => root.render(<StreamView items={ stream } active working />));

        const text = container.textContent ?? '';

        expect(group('Ran 2 commands')!.getAttribute('aria-expanded')).toBe('false');
        expect(group('Running 2 commands')!.getAttribute('aria-expanded')).toBe('true');
        expect(text.indexOf('Ran 2 commands')).toBeLessThan(text.indexOf('That is the right box'));
        expect(text.indexOf('That is the right box')).toBeLessThan(text.indexOf('Running 2 commands'));
        expect(text).not.toContain('whoami');
        expect(text).toContain('bun run build');

        // The agent writes more: the second phase closes too, and a third begins.
        await act(async () => root.render(<StreamView items={ [...stream.slice(0, 5), bash(5, 'bun test'), said(6, 'Green. One last check.'), bash(7, 'git status'), bash(8, 'git diff', 'running')] } active working />));

        expect(container.querySelectorAll('button[aria-expanded]').length).toBeGreaterThanOrEqual(3);
        expect(container.textContent).not.toContain('bun run build');
        expect(container.textContent).toContain('git status');
    });

    it('says on the line whether the calls show, and shimmers it only while a call runs', async () => {
        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'bun test', 'running')] } active working />));

        const running = group('Running 2 commands')!;

        expect(running.getAttribute('aria-expanded')).toBe('true');
        expect(running.querySelector('[style*="shimmer"]')).not.toBeNull();

        await act(async () => running.click());

        expect(group('Running 2 commands')!.getAttribute('aria-expanded')).toBe('false');

        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'bun test')] } active />));

        expect(group('Ran 2 commands')!.getAttribute('aria-expanded')).toBe('false');
        expect(group('Ran 2 commands')!.querySelector('[style*="shimmer"]')).toBeNull();
    });

    it('keeps the group a person opened open when the agent goes on', async () => {
        const going = [asked, bash(1, 'pwd'), bash(2, 'whoami')];

        await act(async () => root.render(<StreamView items={ [...going, said(3, 'Next.', false)] } active />));
        await act(async () => group('Ran 2 commands')!.click());
        await act(async () => root.render(<StreamView items={ [...going, said(3, 'Next.'), bash(4, 'date'), bash(5, 'uptime', 'running')] } active working />));

        expect(container.textContent).toContain('whoami');
        expect(group('Running 2 commands')).toBeDefined();
    });

    it('puts the divider of a fork after the group that holds its point', async () => {
        await act(async () => root.render(<StreamView items={ [asked, bash(1, 'pwd'), bash(2, 'whoami'), bash(3, 'date')] } forkedFrom={ { atSeq: 2, title: 'Check the box' } } />));

        const divider = container.querySelector<HTMLElement>('[data-slot="fork-divider"]');

        expect(divider?.previousElementSibling?.textContent).toContain('Ran 3 commands');
    });
});

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

    it('draws the progress loader in the working line', async () => {
        await act(async () => root.render(<StreamView items={ items } active working />));

        expect(container.querySelector('[role="status"] #progress-loader-a')).not.toBeNull();
    });

    it('puts the action it is given at the end of an error', async () => {
        const failed = [...items, item(4, { kind: 'error', text: 'The conversation no longer fits the model\'s context window. Compact it or start a new chat.' })];

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

    it('keeps the message rail away until the seventh message', async () => {
        const few = Array.from({ length: 6 }, (_, n) => item(n, { kind: 'user', text: `Ask ${ n }` }));

        await act(async () => root.render(<StreamView items={ few } />));

        expect(container.querySelector('[aria-label="Messages"]')).toBeNull();
    });

    it('draws a tick per message from the seventh, and a press scrolls the stream to it', async () => {
        const many = Array.from({ length: 7 }, (_, n) => item(n, { kind: 'user', text: `Ask ${ n }` }));

        await act(async () => root.render(<StreamView items={ many } />));

        const rail = container.querySelector('[aria-label="Messages"]');
        const message = container.querySelector<HTMLElement>('[data-turn="i-4"]');
        const scroll = message?.parentElement?.parentElement as HTMLElement;
        const box = (top: number, height: number): DOMRect => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) });

        expect(rail?.querySelectorAll('[data-tick]')).toHaveLength(7);
        expect(message).not.toBeNull();

        message!.getBoundingClientRect = () => box(300, 40);
        scroll.getBoundingClientRect = () => box(100, 700);
        scroll.scrollTop = 40;
        const scrolled = vi.spyOn(scroll, 'scrollTo');

        await act(async () => rail?.querySelector<HTMLButtonElement>('[data-tick="i-4"]')?.click());

        expect(scrolled).toHaveBeenCalledWith({ top: 224, behavior: 'auto' });
    });

    it('makes the last tick current once the stream is scrolled to its end, though the last message has not reached the top', async () => {
        const many = Array.from({ length: 7 }, (_, n) => item(n, { kind: 'user', text: `Ask ${ n }` }));

        await act(async () => root.render(<StreamView items={ many } />));

        const rail = container.querySelector('[aria-label="Messages"]');
        const scroll = container.querySelector<HTMLElement>('[data-turn="i-4"]')?.parentElement?.parentElement as HTMLElement;
        const box = (top: number): DOMRect => ({ top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) });
        const current = () => rail?.querySelector('[aria-current]')?.getAttribute('data-tick');
        const scrollTo = async (top: number) => {
            Object.defineProperty(scroll, 'scrollTop', { configurable: true, value: top });
            await act(async () => void scroll.dispatchEvent(new Event('scroll')));
        };

        // Every message sits below the top of the stream, as the last ones do when the answers are short.
        scroll.getBoundingClientRect = () => box(0);
        container.querySelectorAll<HTMLElement>('[data-turn]').forEach((message, n) => void (message.getBoundingClientRect = () => box(300 + n * 100)));
        Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2000 });
        Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 700 });

        await scrollTo(0);
        expect(current()).toBe('i-0');

        await scrollTo(1299);
        expect(current()).toBe('i-6');
    });

    it('keeps one card and swaps its text as the pointer moves across ticks', async () => {
        const many = Array.from({ length: 7 }, (_, n) => item(n, { kind: 'user', text: `Ask ${ n }` }));

        await act(async () => root.render(<StreamView items={ many } />));

        const rail = container.querySelector('[aria-label="Messages"]')?.parentElement;
        const move = (id: string) => rail?.querySelector(`[data-tick="${ id }"]`)?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 40 }));

        await act(async () => move('i-1'));

        const card = document.querySelector('[data-turn-card]');

        expect(document.querySelectorAll('[data-turn-card]')).toHaveLength(1);
        expect(card?.textContent).toContain('Ask 1');

        await act(async () => move('i-4'));

        expect(document.querySelector('[data-turn-card]')).toBe(card);
        expect(card?.textContent).toContain('Ask 4');
        expect(card?.textContent).not.toContain('Ask 1');
    });

    describe('message actions', () => {
        const thread = (n: number): StreamItem => item(n, { kind: 'user', text: 'Done', from: { kind: 'thread', chatId: 'c-2', title: 'Fix login' } });
        const notice = (n: number): StreamItem => item(n, { kind: 'user', text: '', from: { kind: 'threadNotice', threads: [{ chatId: 'c-3', title: 'Write tests', outcome: 'finished', text: 'Passing.' }] } });
        const twoTurns = [...items, item(4, { kind: 'user', text: 'Now the table' }), item(5, { kind: 'assistant', text: 'The table is done.', done: true })];
        const rows = () => [...container.querySelectorAll<HTMLElement>('time')].map(time => time.parentElement as HTMLElement);
        const rowAfter = (text: string) => [...container.querySelectorAll<HTMLElement>('time')].find(time => time.parentElement?.parentElement?.textContent?.includes(text))?.parentElement;
        const drawWith = (list: StreamItem[], props: { active?: boolean; messageActions?: StreamViewProps['messageActions']; editing?: StreamViewProps['editing'] } = { messageActions: {} }) => act(async () => root.render(<StreamView items={ list } { ...props } />));

        it('draws a row under each message of the person and the answer of each turn, and none under the rest', async () => {
            await drawWith(twoTurns, { active: false, messageActions: {} });

            expect(rows()).toHaveLength(4);
            expect(rowAfter('Fix the form')?.dataset.align).toBe('end');
            expect(rowAfter('The form is fixed.')?.dataset.align).toBe('start');
            // The words on the way are folded and have none, and a sentence of work is no answer.
            expect(rowAfter('Looking at it.')).toBeUndefined();
        });

        it('draws nothing unless the caller asks, as on the page of a run that only reads', async () => {
            await drawWith(items, { active: false });

            expect(container.querySelector('time')).toBeNull();
            expect(container.querySelector('[aria-label="Copy message"]')).toBeNull();
        });

        it('keeps the turn rail\'s mark on the root of the person\'s message, with the row inside it', async () => {
            await drawWith(items, { active: false, messageActions: {} });

            const bubble = container.querySelector<HTMLElement>('[data-turn="i-0"]');

            expect(bubble?.lastElementChild?.querySelector('time')).not.toBeNull();
        });

        it('gives no row to what another thread wrote or to the notice of threads that stopped', async () => {
            await drawWith([thread(0), item(1, { kind: 'assistant', text: 'Noted.', done: true }), notice(2)], { active: false, messageActions: {} });

            // Only the answer to the thread's message has a row.
            expect(rows()).toHaveLength(1);
            expect(rows()[0].dataset.align).toBe('start');
        });

        it('gives the answer of a live turn no row until it is done, and the person\'s message its row', async () => {
            await drawWith(items, { active: true, messageActions: {} });

            expect(rows()).toHaveLength(1);
            expect(rows()[0].dataset.align).toBe('end');

            const writing = [...items.slice(0, 3), item(3, { kind: 'assistant', text: 'The form', done: false })];

            await drawWith(writing, { active: false, messageActions: {} });

            expect(rowAfter('The form')).toBeUndefined();
        });

        it('draws no row inside the fold when it is opened', async () => {
            await drawWith(items, { active: false, messageActions: {} });
            await act(async () => worked()!.click());

            expect(container.textContent).toContain('Looking at it.');
            expect(rows()).toHaveLength(2);
        });

        it('shows the row of the last message that has one, and leaves the others to the pointer', async () => {
            await drawWith(twoTurns, { active: false, messageActions: {} });

            expect(rows().map(row => row.dataset.show)).toEqual(['hover', 'hover', 'hover', 'always']);
            expect(rowAfter('The table is done.')?.dataset.show).toBe('always');
        });

        it('moves the last row to the person\'s message while the agent answers, and to the answer when it is done', async () => {
            await drawWith([...twoTurns.slice(0, 5), item(6, { kind: 'tool', toolCallId: 't2', name: 'Read', input: {}, state: 'running' })], { active: true, messageActions: {} });

            expect(rowAfter('Now the table')?.dataset.show).toBe('always');
            expect(rowAfter('The form is fixed.')?.dataset.show).toBe('hover');

            await drawWith(twoTurns, { active: false, messageActions: {} });

            expect(rowAfter('Now the table')?.dataset.show).toBe('hover');
            expect(rowAfter('The table is done.')?.dataset.show).toBe('always');
        });

        it('does not take the last row for a message that has none', async () => {
            await drawWith([...twoTurns, notice(6)], { active: false, messageActions: {} });

            expect(rowAfter('The table is done.')?.dataset.show).toBe('always');
        });
        describe('Reply', () => {
            const replyButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Reply"]')];
            const toolbar = () => document.body.querySelector('[role="toolbar"]');
            /** The text node that holds `words` inside the message root `selector` names. */
            const textNode = (selector: string, words: string) => {
                const walker = document.createTreeWalker(container.querySelector(selector)!, NodeFilter.SHOW_TEXT);

                for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.includes(words)) return node;

                throw new Error(`No text with ${ words }`);
            };

            it('draws a Reply under the person\'s messages and the answers, and hands over the message as it was written', async () => {
                const onReply = vi.fn();
                const marked = [...twoTurns.slice(0, 4), item(4, { kind: 'user', text: 'Now **the** table' }), twoTurns[5]];

                await drawWith(marked, { active: false, messageActions: { onReply } });

                expect(replyButtons()).toHaveLength(4);

                await act(async () => replyButtons()[2].click());
                await act(async () => replyButtons()[3].click());

                // Who wrote it goes with the words: the person, or the agent whose answer it is.
                expect(onReply.mock.calls).toEqual([[{ role: 'user', text: 'Now **the** table' }], [{ role: 'assistant', text: 'The table is done.' }]]);
            });

            it('draws none where no handler is given, whatever else the rows have', async () => {
                await drawWith(twoTurns, { active: false, messageActions: {} });

                expect(rows()).toHaveLength(4);
                expect(replyButtons()).toHaveLength(0);
            });

            it('draws none for a message that has no row', async () => {
                await drawWith([...twoTurns, notice(6)], { active: false, messageActions: { onReply: vi.fn() } });

                expect(replyButtons()).toHaveLength(4);
            });

            it('lets the messages be swiped to reply only when the stream says so, with the same hand-over as the button', async () => {
                const onReply = vi.fn();
                const messages = () => [...container.querySelectorAll<HTMLElement>('[data-message]')];
                const swipe = (target: HTMLElement) => Array.from({ length: 30 }, () => target.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, deltaY: 0, bubbles: true, cancelable: true })));
                // A swipe replies when it is over, once the wheel has been quiet for a while.
                const quiet = () => new Promise(resolve => setTimeout(resolve, SWIPE.idleMs + 50));

                await drawWith(twoTurns, { active: false, messageActions: { onReply } });

                expect(swipe(messages()[0]).every(untouched => untouched)).toBe(true);
                await quiet();
                expect(onReply).not.toHaveBeenCalled();

                await drawWith(twoTurns, { active: false, messageActions: { onReply, swipeToReply: true } });
                swipe(messages()[0]);
                await quiet();
                swipe(messages().find(node => node.textContent?.includes('The table is done.'))!);
                await quiet();

                expect(onReply.mock.calls).toEqual([[{ role: 'user', text: 'Fix the form' }], [{ role: 'assistant', text: 'The table is done.' }]]);
            });

            it('has no swipe where there is no Reply, even when the stream says swipes are on', async () => {
                await drawWith(twoTurns, { active: false, messageActions: { swipeToReply: true } });

                const events = Array.from({ length: 30 }, () => container.querySelector('[data-message]')!.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, deltaY: 0, bubbles: true, cancelable: true })));

                expect(events.every(untouched => untouched)).toBe(true);
                expect(container.querySelector<HTMLElement>('[data-message]')!.style.translate).toBe('');
            });

            it('offers Reply on a selection inside one message, and only when the stream has a handler for a quote', async () => {
                const frames: FrameRequestCallback[] = [];

                vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
                vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [{ left: 10, right: 90, top: 100, bottom: 120, width: 80, height: 20 }] as unknown as DOMRectList);
                vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 10, right: 90, top: 100, bottom: 120, width: 80, height: 20 }) as DOMRect);

                const selectIn = async (selector: string, words: string) => {
                    const node = textNode(selector, words);
                    const range = document.createRange();

                    range.setStart(node, node.textContent!.indexOf(words));
                    range.setEnd(node, node.textContent!.indexOf(words) + words.length);
                    window.getSelection()!.removeAllRanges();
                    window.getSelection()!.addRange(range);
                    document.dispatchEvent(new Event('selectionchange'));
                    await act(async () => frames.splice(0).forEach(callback => callback(0)));
                };

                try {
                    await drawWith(twoTurns, { active: false, messageActions: { onQuote: vi.fn() } });
                    await selectIn('[data-turn="i-0"]', 'the form');

                    expect(toolbar()?.textContent).toBe('Reply');

                    // A whole-message reply is no reason for the toolbar: it quotes words, and has a handler of its own.
                    window.getSelection()!.removeAllRanges();
                    await drawWith(twoTurns, { active: false, messageActions: { onReply: vi.fn() } });
                    await selectIn('[data-turn="i-0"]', 'the form');

                    expect(toolbar()).toBeNull();

                    window.getSelection()!.removeAllRanges();
                    await drawWith(twoTurns, { active: false, messageActions: {} });
                    await selectIn('[data-turn="i-0"]', 'the form');

                    expect(toolbar()).toBeNull();
                }
                finally {
                    window.getSelection()!.removeAllRanges();
                    vi.unstubAllGlobals();
                    vi.restoreAllMocks();
                }
            });
        });

        describe('Fork', () => {
            const forkButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Fork into new chat"]')];
            // The first turn's answer and the second's can be forked; so can a message that is no answer, which is not drawn all the same.
            const forkable = [
                { ...twoTurns[0], canFork: true },
                twoTurns[1],
                { ...twoTurns[2], canFork: true },
                { ...twoTurns[3], canFork: true },
                twoTurns[4],
                { ...twoTurns[5], canFork: true },
            ];

            it('draws a Fork under an answer the daemon marked, and nowhere else, and hands over the answer\'s item', async () => {
                const onFork = vi.fn();

                await drawWith(forkable, { active: false, messageActions: { onFork } });

                // Two answers are marked; a message of the person's, and a call inside the fold, carry the flag and get no button.
                expect(forkButtons()).toHaveLength(2);

                await act(async () => forkButtons()[1].click());

                expect(onFork).toHaveBeenCalledExactlyOnceWith('i-5');
            });

            it('draws none for an answer that is not marked, or where no handler is given', async () => {
                await drawWith(twoTurns, { active: false, messageActions: { onFork: vi.fn() } });

                expect(forkButtons()).toHaveLength(0);

                await drawWith(forkable, { active: false, messageActions: {} });

                expect(forkButtons()).toHaveLength(0);
            });

            it('draws none for a stream that is not given actions, as on the page of a run that only reads', async () => {
                await drawWith(forkable, { active: false });

                expect(forkButtons()).toHaveLength(0);
            });

            it('spins the button of the answer being forked and turns the others off', async () => {
                const onFork = vi.fn();

                await drawWith(forkable, { active: false, messageActions: { onFork, forkingId: 'i-5' } });

                expect(forkButtons().map(button => [button.hasAttribute('data-pending'), button.disabled])).toEqual([[false, true], [true, false]]);

                await act(async () => forkButtons().forEach(button => button.click()));

                expect(onFork).not.toHaveBeenCalled();
            });
        });

        describe('Edit', () => {
            const editButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Edit message"]')];
            const frame = () => container.querySelector<HTMLElement>('[role="group"][aria-label="Editing message"]');
            const toolbar = () => document.body.querySelector('[role="toolbar"]');
            // Both messages of the person's start a turn and can be rewritten from; the third is a steer inside the second turn, which cannot.
            const editable = [
                { ...twoTurns[0], canEdit: true },
                twoTurns[1],
                twoTurns[2],
                twoTurns[3],
                { ...twoTurns[4], canEdit: true },
                twoTurns[5],
                item(6, { kind: 'user', text: 'And keep it on one line' }),
            ];
            const editing = (itemId: string, onCancel = vi.fn()) => ({ itemId, onCancel, editor: <div contentEditable suppressContentEditableWarning data-testid="editor">Fix the form</div> });

            it('draws an Edit under each message of the person\'s that the daemon marked, and hands over its item', async () => {
                const onEdit = vi.fn();

                await drawWith(editable, { active: false, messageActions: { onEdit } });

                // Not under the steer, which has a row and no flag; not under an answer.
                expect(editButtons()).toHaveLength(2);

                await act(async () => editButtons()[1].click());

                expect(onEdit).toHaveBeenCalledExactlyOnceWith('i-4');
            });

            it('draws none where no handler is given, for a flag on a message that is no message of the person\'s, or on a page that only reads', async () => {
                await drawWith(editable, { active: false, messageActions: {} });

                expect(editButtons()).toHaveLength(0);

                await drawWith([...editable, { ...thread(7), canEdit: true }, { ...twoTurns[5], canEdit: true }], { active: false, messageActions: { onEdit: vi.fn() } });

                expect(editButtons()).toHaveLength(2);

                await drawWith(editable, { active: false });

                expect(editButtons()).toHaveLength(0);
            });

            it('is off, and says so, on every row while the agent works', async () => {
                const onEdit = vi.fn();

                await drawWith(editable, { active: true, messageActions: { onEdit, editBusy: true } });

                expect(editButtons().map(button => button.disabled)).toEqual([true, true]);
                expect(container.querySelectorAll('[role="button"][aria-disabled][aria-label="Edit message"]')).toHaveLength(2);

                await act(async () => editButtons().forEach(button => button.click()));

                expect(onEdit).not.toHaveBeenCalled();
            });

            it('puts the frame where the bubble stood, with the turn rail\'s mark, and keeps everything around it', async () => {
                await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() }, editing: editing('i-4') });

                const group = frame()!;

                expect(group.dataset.turn).toBe('i-4');
                expect(group.textContent).toContain('Editing message');
                expect(group.querySelector('[data-testid="editor"]')).not.toBeNull();
                // The bubble is gone, and the turns before and after are as they were.
                expect(container.querySelectorAll('[data-turn="i-4"]')).toHaveLength(1);
                expect(container.querySelector('[data-message][data-turn="i-4"]')).toBeNull();
                expect(container.textContent).not.toContain('Now the table');
                expect(container.querySelector('[data-turn="i-0"]')?.textContent).toContain('Fix the form');
                expect(container.textContent).toContain('The table is done.');
                expect(container.textContent).toContain('And keep it on one line');
                // The frame stands between the two turns.
                expect(group.previousElementSibling?.textContent).toContain('The form is fixed.');
                expect(group.nextElementSibling?.textContent).toContain('The table is done.');
            });

            it('takes the Edit of every other message away while one is being edited, and brings it back afterwards', async () => {
                await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() }, editing: editing('i-4') });

                expect(editButtons()).toHaveLength(0);

                await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() } });

                expect(editButtons()).toHaveLength(2);
                expect(frame()).toBeNull();
            });

            it('hands the focus to its message\'s Edit button when the frame closes with the focus in it, and leaves a focus that is elsewhere alone', async () => {
                const withField = { ...editing('i-4'), editor: <input data-testid="editor-input" /> };
                const outside = document.createElement('input');
                const bubbleEdit = () => container.querySelector('[data-message][data-turn="i-4"] button[aria-label="Edit message"]');

                document.body.append(outside);

                try {
                    await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() }, editing: withField });
                    container.querySelector<HTMLInputElement>('[data-testid="editor-input"]')!.focus();
                    await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() } });

                    expect(bubbleEdit()).not.toBeNull();
                    expect(document.activeElement).toBe(bubbleEdit());

                    // The focus went to the box at the bottom while the frame was open: closing the frame does not take it back.
                    await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() }, editing: withField });
                    outside.focus();
                    await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() } });

                    expect(document.activeElement).toBe(outside);
                }
                finally {
                    outside.remove();
                }
            });

            it('does not make the bubble rise into place a second time when the frame goes, for a message that came after the stream was shown', async () => {
                const bubble = () => container.querySelector('[data-message][data-turn="i-4"]');

                // The first draw has the first turn alone, so the second message is news.
                await drawWith(editable.slice(0, 4), { active: false, messageActions: { onEdit: vi.fn() } });
                await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() } });

                expect(bubble()?.hasAttribute('data-animate')).toBe(true);

                await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() }, editing: editing('i-4') });
                await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() } });

                expect(bubble()).not.toBeNull();
                expect(bubble()?.hasAttribute('data-animate')).toBe(false);
            });

            it('stops editing from the X of the frame', async () => {
                const onCancel = vi.fn();

                await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() }, editing: editing('i-4', onCancel) });

                const close = container.querySelector<HTMLButtonElement>('button[aria-label="Stop editing"]')!;

                expect(frame()?.contains(close)).toBe(true);

                await act(async () => close.click());

                expect(onCancel).toHaveBeenCalledOnce();
            });

            it('draws nothing for an edit of a message the stream does not have, and keeps the rest', async () => {
                await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn() }, editing: editing('i-99') });

                expect(frame()).toBeNull();
                expect(container.textContent).toContain('Now the table');
                // The edit is still open as far as the stream is told, so no message offers Edit.
                expect(editButtons()).toHaveLength(0);
            });

            it('offers no Reply on a selection inside the frame, while one inside a message still gets it', async () => {
                const frames: FrameRequestCallback[] = [];

                vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
                vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [{ left: 10, right: 90, top: 100, bottom: 120, width: 80, height: 20 }] as unknown as DOMRectList);
                vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 10, right: 90, top: 100, bottom: 120, width: 80, height: 20 }) as DOMRect);

                const selectIn = async (selector: string) => {
                    const walker = document.createTreeWalker(container.querySelector(selector)!, NodeFilter.SHOW_TEXT);
                    const node = walker.nextNode()!;
                    const range = document.createRange();

                    range.setStart(node, 0);
                    range.setEnd(node, 5);
                    window.getSelection()!.removeAllRanges();
                    window.getSelection()!.addRange(range);
                    document.dispatchEvent(new Event('selectionchange'));
                    await act(async () => frames.splice(0).forEach(callback => callback(0)));
                };

                try {
                    await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn(), onQuote: vi.fn() }, editing: editing('i-4') });
                    await selectIn('[data-testid="editor"]');

                    expect(toolbar()).toBeNull();

                    await selectIn('[data-turn="i-0"]');

                    expect(toolbar()?.textContent).toBe('Reply');
                }
                finally {
                    window.getSelection()!.removeAllRanges();
                    vi.unstubAllGlobals();
                    vi.restoreAllMocks();
                }
            });
        });
    });

    describe('the divider of a fork', () => {
        const twoTurns = [...items, item(4, { kind: 'user', text: 'Now the table' }), item(5, { kind: 'assistant', text: 'The table is done.', done: true })];
        const divider = () => container.querySelector<HTMLElement>('[data-slot="fork-divider"]');
        const drawFork = (forkedFrom: StreamViewProps['forkedFrom'], list: StreamItem[] = twoTurns) => act(async () => root.render(<StreamView items={ list } active={ false } forkedFrom={ forkedFrom } />));
        /** What stands right before the divider: the block of the stream it follows. */
        const before = () => divider()?.previousElementSibling?.textContent;
        const after = () => divider()?.nextElementSibling?.textContent;

        it('stands right after the item whose number is the fork point, the answer, and before what the chat wrote itself', async () => {
            await drawFork({ atSeq: 3, title: 'Fix the form' });

            expect(before()).toContain('The form is fixed.');
            expect(after()).toContain('Now the table');
        });

        it('names the source and opens it from the title', async () => {
            const onOpen = vi.fn();

            await drawFork({ atSeq: 3, title: 'Fix the form', onOpen });

            expect(divider()?.textContent).toBe('Forked from Fix the form');

            await act(async () => divider()!.querySelector('button')!.click());

            expect(onOpen).toHaveBeenCalledOnce();
        });

        it('names a source it cannot open in plain words, and says only Forked when the source is gone', async () => {
            await drawFork({ atSeq: 3, title: 'Fix the form' });

            expect(divider()?.textContent).toBe('Forked from Fix the form');
            expect(divider()?.querySelector('button')).toBeNull();

            await drawFork({ atSeq: 3 });

            expect(divider()?.textContent).toBe('Forked');
            expect(divider()?.querySelector('button')).toBeNull();
        });

        it('goes after the last item before the number when the stream does not have it', async () => {
            const gap = [items[0], items[1], items[2], items[3], item(7, { kind: 'user', text: 'Later' }), item(8, { kind: 'assistant', text: 'Later answer.', done: true })];

            await drawFork({ atSeq: 5, title: 'Fix the form' }, gap);

            expect(before()).toContain('The form is fixed.');
            expect(after()).toContain('Later');
        });

        it('goes after the fold when the point is a call inside it', async () => {
            await drawFork({ atSeq: 2, title: 'Fix the form' });

            expect(before()).toContain('Worked for');
            expect(after()).toContain('The form is fixed.');
        });

        it('is not drawn when the stream has not reached the fork point, and not for a chat that is no fork', async () => {
            await drawFork({ atSeq: 9, title: 'Fix the form' });

            expect(divider()).toBeNull();

            await drawFork(undefined);

            expect(divider()).toBeNull();
        });

        it('stays at the same place while the chat goes on after it', async () => {
            await drawFork({ atSeq: 3, title: 'Fix the form' });
            await drawFork({ atSeq: 3, title: 'Fix the form' }, [...twoTurns, item(6, { kind: 'user', text: 'And one more' }), item(7, { kind: 'assistant', text: 'One more done.', done: true })]);

            expect(before()).toContain('The form is fixed.');
            expect(after()).toContain('Now the table');
        });

        it('is no part of the turn rail: the messages that start a turn keep their marks, and the divider has none', async () => {
            await drawFork({ atSeq: 3, title: 'Fix the form' });

            expect([...container.querySelectorAll('[data-turn]')].map(node => node.getAttribute('data-turn'))).toEqual(['i-0', 'i-4']);
            expect(divider()?.hasAttribute('data-turn')).toBe(false);
            expect(divider()?.querySelector('time')).toBeNull();
        });
    });
});
