// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamView, type StreamViewProps } from './StreamView';

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

                expect(onReply.mock.calls).toEqual([['Now **the** table'], ['The table is done.']]);
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

            it('offers Reply on a selection inside one message, and only when the stream has a handler', async () => {
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
                    await drawWith(twoTurns, { active: false, messageActions: { onReply: vi.fn() } });
                    await selectIn('[data-turn="i-0"]', 'the form');

                    expect(toolbar()?.textContent).toBe('Reply');

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
                    await drawWith(editable, { active: false, messageActions: { onEdit: vi.fn(), onReply: vi.fn() }, editing: editing('i-4') });
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
