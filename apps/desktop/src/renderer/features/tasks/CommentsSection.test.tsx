// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { RootStore, RootStoreProvider } from '../../stores';
import { CommentsSection } from './CommentsSection';
import { memoryStorage } from './screenHarness';

import type { CommandResult, TaskComment } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';
import type { TaskComments } from './useTaskComments';

// The hook is tested by itself (`useTaskComments.test.tsx`): here the section is given the states it can be in.
const feed = vi.hoisted(() => ({
    state: { status: 'loading' } as unknown as TaskComments,
    retry: vi.fn<() => void>(),
}));

vi.mock('./useTaskComments', () => ({ MAX_COMMENTS: 1000, useTaskComments: () => feed }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The comments section of CAR-32 on the demo project, on a real store: the demo's runs are in it (`r-orch-1` is the orchestrator of the chat "Simplify booking"), and the daemon is a stand-in that answers each command
 * as the test says and remembers it.
 */

const comment = (id: string, body: string, rest: Partial<TaskComment> = {}): TaskComment => ({
    id,
    taskId: 't-32',
    author: { kind: 'user' },
    body,
    createdAt: Date.UTC(2026, 10, 20, 9, 0),
    ...rest,
});

const MINE = comment('c-mine', 'Keep the amount in cents.');
const AGENTS = comment(
    'c-agent',
    'The form posts to `/api/pay`.\n\n- the card number never reaches our server\n- a declined card answers `402`\n\nNext: the declined state (`CAR-34`).',
    { author: { kind: 'run', runId: 'r-orch-1' } }
);
const EDITED = comment('c-edited', 'Looks right.', { editedAt: Date.UTC(2026, 10, 21, 9, 0) });

const ready = (
    comments: TaskComment[],
    rest: Partial<Extract<TaskComments, { status: 'ready' }>> = {}
): TaskComments => ({ status: 'ready', comments, total: comments.length, isCut: false, ...rest });

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let sent: CommandInput[];
let answer: (input: CommandInput) => CommandResult | Promise<CommandResult>;
let onOpenRun: ReturnType<typeof vi.fn<(runId: string) => void>>;
let onOpenTask: ReturnType<typeof vi.fn<(taskId: string) => void>>;

const accepted = (data: unknown = {}): CommandResult => ({ ok: true, requestId: 'r', data });
const refused = (message: string): CommandResult => ({
    ok: false,
    requestId: 'r',
    error: { code: 'invalid', message },
});

const draw = (taskId = 't-32') =>
    act(async () =>
        reactRoot.render(
            <RootStoreProvider value={store}>
                <CommentsSection taskId={taskId} onOpenRun={onOpenRun} onOpenTask={onOpenTask} />
            </RootStoreProvider>
        )
    );

const show = (state: TaskComments) => {
    feed.state = state;

    return draw();
};

beforeEach(async () => {
    sent = [];
    answer = () => accepted();
    onOpenRun = vi.fn();
    onOpenTask = vi.fn();
    feed.state = { status: 'loading' };
    feed.retry.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);

    const daemon = new FixtureTransport();

    store = new RootStore(
        overrideTransport(daemon, {
            command: async input => {
                sent.push(input);

                return answer(input);
            },
        }),
        { storage: memoryStorage() }
    );
    await store.load();
});

afterEach(() => {
    act(() => reactRoot.unmount());
    store.dispose();
    container.remove();
    vi.restoreAllMocks();
});

const article = (id: string) => container.querySelector<HTMLElement>(`article[data-comment-id="${id}"]`)!;
const named = (name: string, within: ParentNode = container) =>
    [...within.querySelectorAll<HTMLElement>('button')].find(
        button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name
    );
/** Delete says Delete and Confirm in turns, and holds both in the button: it is found by the word it starts with. */
const deleteButton = (within: ParentNode) =>
    [...within.querySelectorAll<HTMLElement>('button')].find(button => button.textContent?.includes('Delete'));
const press = (element: Element | undefined) => act(async () => (element as HTMLElement).click());
const editorOf = (label: string) =>
    (container.querySelector(`[contenteditable][aria-label="${label}"]`) as HTMLElement & { editor: Editor }).editor;
const type = (label: string, text: string) =>
    act(async () => void editorOf(label).chain().focus('end').insertContent(text).run());

/** A key in the editor, as the browser sends it. It reports whether the page let it be (the editor's own handling is `defaultPrevented`). */
async function key(label: string, init: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

    await act(
        async () => void container.querySelector(`[contenteditable][aria-label="${label}"]`)!.dispatchEvent(event)
    );

    return event;
}

describe('what the section shows while it waits and when it cannot', () => {
    it('shows the loader with its line while the comments load, and the composer already', async () => {
        await show({ status: 'loading' });

        expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull();
        expect(container.textContent).toContain('Loading comments…');
        expect(container.querySelector('[contenteditable][aria-label="Write a comment"]')).not.toBeNull();
    });

    it('says the comments did not load and offers Retry, which the hook answers', async () => {
        await show({ status: 'failed', message: 'The daemon cannot be reached' });

        expect(container.textContent).toContain('Comments did not load');

        await press(named('Retry'));

        expect(feed.retry).toHaveBeenCalledTimes(1);
    });

    it('keeps the comments on show when a read for a change failed, says so under them and offers Retry, which the hook answers', async () => {
        await show(ready([MINE, AGENTS], { refreshError: 'The daemon cannot be reached' }));

        expect([...container.querySelectorAll('article')].map(found => found.dataset.commentId)).toEqual([
            'c-mine',
            'c-agent',
        ]);
        expect(container.querySelector('[role="alert"]')!.textContent).toContain('Comments did not refresh');
        expect(container.textContent).not.toContain('Comments did not load');
        // The composer is there as before.
        expect(container.querySelector('[contenteditable][aria-label="Write a comment"]')).not.toBeNull();

        await press(named('Retry'));

        expect(feed.retry).toHaveBeenCalledTimes(1);
    });

    it('says nothing about a refresh when none failed, and drops the line once the comments are read again', async () => {
        await show(ready([MINE], { refreshError: 'The daemon cannot be reached' }));
        await show(ready([MINE, AGENTS]));

        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.textContent).not.toContain('did not refresh');
    });

    it('says there are none yet, with no count in the header', async () => {
        await show(ready([]));

        expect(container.textContent).toContain('No comments yet');
        expect(container.querySelector('section')!.firstElementChild!.textContent).toBe('Comments');
    });

    it('says the task has more than it shows, when the hook stopped at the cap, and counts all of them in the header', async () => {
        await show(ready([MINE], { total: 1200, isCut: true }));

        expect(container.textContent).toContain('Showing the first 1000 comments');
        expect(container.querySelector('section')!.firstElementChild!.textContent).toBe('Comments1200');
    });

    it('does not say it for a task whose comments are all shown', async () => {
        await show(ready([MINE]));

        expect(container.textContent).not.toContain('Showing the first');
    });
});

describe('a comment', () => {
    it('shows the comments in the order it is given them, with the count in the header', async () => {
        await show(ready([MINE, AGENTS, EDITED]));

        expect([...container.querySelectorAll('article')].map(found => found.dataset.commentId)).toEqual([
            'c-mine',
            'c-agent',
            'c-edited',
        ]);
        expect(container.querySelector('section')!.firstElementChild!.textContent).toBe('Comments3');
    });

    it('draws the Markdown: a list, and the code of a task key as a chip that opens the task', async () => {
        await show(ready([AGENTS]));

        expect(article('c-agent').querySelectorAll('[data-streamdown="list-item"]')).toHaveLength(2);
        expect(article('c-agent').querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('/api/pay');

        const chip = [...article('c-agent').querySelectorAll('button')].find(button =>
            button.textContent?.includes('CAR-34')
        )!;

        await press(chip);

        expect(onOpenTask).toHaveBeenCalledWith('t-34');
    });

    it('calls the person "You"', async () => {
        await show(ready([MINE]));

        expect(article('c-mine').querySelector('header')!.textContent).toMatch(/^You/);
    });

    it('names an agent whose run is still there, as a link that opens the run', async () => {
        await show(ready([AGENTS]));

        const link = named('Simplify booking', article('c-agent'))!;

        expect(link).toBeDefined();

        await press(link);

        expect(onOpenRun).toHaveBeenCalledExactlyOnceWith('r-orch-1');
    });

    it('names an agent whose run has been deleted "Agent", as plain text: a comment must not link to nothing', async () => {
        await show(ready([comment('c-gone', 'Done.', { author: { kind: 'run', runId: 'r-deleted' } })]));

        const head = article('c-gone').querySelector('header')!;

        expect(head.textContent).toMatch(/^Agent/);
        expect(head.querySelector('button')).toBeNull();
    });

    it('names the provider of a comment that came in from another tracker', async () => {
        await show(ready([comment('c-linear', 'Synced.', { author: { kind: 'provider', provider: 'linear' } })]));

        expect(article('c-linear').querySelector('header')!.textContent).toMatch(/^linear/);
        expect(article('c-linear').querySelector('header button')).toBeNull();
    });

    it('shows when it was written, with the whole date on hover, and "edited" only for a comment that was', async () => {
        await show(ready([MINE, EDITED]));

        const time = article('c-mine').querySelector('time')!;

        expect(time.getAttribute('datetime')).toBe(new Date(MINE.createdAt).toISOString());
        expect(time.title).toMatch(/2026/);
        expect(time.textContent).toMatch(/\d{2}:\d{2}$/);
        expect(article('c-mine').textContent).not.toContain('edited');
        expect(article('c-edited').textContent).toContain('edited');
        expect(article('c-edited').querySelector('[title^="Edited"]')).not.toBeNull();
    });

    it("offers Edit and Delete on the person's own comments only, an agent's and another tracker's are read only", async () => {
        await show(
            ready([MINE, AGENTS, comment('c-linear', 'Synced.', { author: { kind: 'provider', provider: 'linear' } })])
        );

        expect(named('Edit comment', article('c-mine'))).toBeDefined();
        expect(deleteButton(article('c-mine'))).toBeDefined();
        expect(named('Edit comment', article('c-agent'))).toBeUndefined();
        expect(deleteButton(article('c-agent'))).toBeUndefined();
        expect(named('Edit comment', article('c-linear'))).toBeUndefined();
    });
});

describe('editing a comment', () => {
    it('swaps the text for the editor, with the body in it', async () => {
        await show(ready([MINE]));
        await press(named('Edit comment'));

        expect(article('c-mine').querySelector('[data-streamdown]')).toBeNull();
        expect(editorOf('Edit comment').getMarkdown()).toBe('Keep the amount in cents.');
    });

    it('saves the new body, trimmed, and closes the editor once the daemon took it', async () => {
        await show(ready([MINE]));
        await press(named('Edit comment'));
        await type('Edit comment', ' Always.  ');
        await press(named('Save'));

        expect(sent).toEqual([
            {
                type: 'task.comment.edit',
                taskId: 't-32',
                commentId: 'c-mine',
                body: 'Keep the amount in cents. Always.',
            },
        ]);
        expect(container.querySelector('[contenteditable][aria-label="Edit comment"]')).toBeNull();
    });

    it('closes without sending anything when the body is as it was, since the daemon would mark the comment edited for nothing', async () => {
        await show(ready([MINE]));
        await press(named('Edit comment'));
        await press(named('Save'));

        expect(sent).toEqual([]);
        expect(container.querySelector('[contenteditable][aria-label="Edit comment"]')).toBeNull();
    });

    it('stays open with the text when the daemon refuses, and says why', async () => {
        const error = vi.spyOn(toast, 'error');

        answer = () => refused('A comment cannot be empty');
        await show(ready([MINE]));
        await press(named('Edit comment'));
        await type('Edit comment', ' Always.');
        await press(named('Save'));

        expect(error).toHaveBeenCalledWith({ message: 'A comment cannot be empty' });
        expect(editorOf('Edit comment').getMarkdown()).toBe('Keep the amount in cents. Always.');
    });

    it('cannot save a body with nothing in it', async () => {
        await show(ready([comment('c-short', 'x')]));
        await press(named('Edit comment'));
        await act(async () => void editorOf('Edit comment').commands.setContent('', { emitUpdate: true }));

        expect(named('Save')!.hasAttribute('disabled')).toBe(true);

        await key('Edit comment', { key: 'Enter', metaKey: true });

        expect(sent).toEqual([]);
    });

    it('is given up with Cancel or Escape, and nothing is sent', async () => {
        await show(ready([MINE]));
        await press(named('Edit comment'));
        await type('Edit comment', ' Always.');
        await press(named('Cancel'));

        expect(container.querySelector('[contenteditable][aria-label="Edit comment"]')).toBeNull();
        expect(article('c-mine').textContent).toContain('Keep the amount in cents.');
        expect(article('c-mine').textContent).not.toContain('Always');

        await press(named('Edit comment'));
        await key('Edit comment', { key: 'Escape' });

        expect(container.querySelector('[contenteditable][aria-label="Edit comment"]')).toBeNull();
        expect(sent).toEqual([]);
    });

    it('puts the keyboard in the editor when it opens, and back on Edit when the edit ends by Cancel, Escape or Save', async () => {
        await show(ready([MINE]));
        await press(named('Edit comment'));

        const field = () => container.querySelector('[contenteditable][aria-label="Edit comment"]');

        expect(document.activeElement).toBe(field());

        await press(named('Cancel'));

        expect(document.activeElement).toBe(named('Edit comment'));

        await press(named('Edit comment'));
        await key('Edit comment', { key: 'Escape' });

        expect(document.activeElement).toBe(named('Edit comment'));

        await press(named('Edit comment'));
        await type('Edit comment', '!');
        await press(named('Save'));

        expect(document.activeElement).toBe(named('Edit comment'));
    });

    it('leaves the keyboard where the person put it when the edit ends after they moved on', async () => {
        let take: (result: CommandResult) => void = () => {};

        answer = () => new Promise(resolve => void (take = resolve));
        await show(ready([MINE, AGENTS]));
        await press(named('Edit comment', article('c-mine')));
        await type('Edit comment', '!');
        await press(named('Save'));

        const elsewhere = named('Simplify booking', article('c-agent'))!;

        await act(async () => elsewhere.focus());
        await act(async () => take(accepted()));

        expect(container.querySelector('[contenteditable][aria-label="Edit comment"]')).toBeNull();
        expect(document.activeElement).toBe(elsewhere);
    });

    it('is not given up by Escape in the link field of the toolbar: that closes the field and the edit goes on', async () => {
        await show(ready([MINE]));
        await press(named('Edit comment'));
        await press(named('Link'));

        const url = document.querySelector<HTMLInputElement>('input[aria-label="URL"]')!;

        expect(url).not.toBeNull();

        await act(
            async () =>
                void url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        );

        expect(container.querySelector('[contenteditable][aria-label="Edit comment"]')).not.toBeNull();
        expect(sent).toEqual([]);
    });

    it('does not send an edit with Cmd+Enter typed in the link field of the toolbar', async () => {
        await show(ready([MINE]));
        await press(named('Edit comment'));
        await type('Edit comment', '!');
        await press(named('Link'));
        await act(
            async () =>
                void document
                    .querySelector('input[aria-label="URL"]')!
                    .dispatchEvent(
                        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
                    )
        );

        expect(sent).toEqual([]);
    });

    it('saves with Cmd+Enter', async () => {
        await show(ready([MINE]));
        await press(named('Edit comment'));
        await type('Edit comment', '!');
        await key('Edit comment', { key: 'Enter', metaKey: true });

        expect(sent).toEqual([
            { type: 'task.comment.edit', taskId: 't-32', commentId: 'c-mine', body: 'Keep the amount in cents.!' },
        ]);
    });
});

describe('deleting a comment', () => {
    const isArmed = () => container.querySelector('[data-confirming]') !== null;

    it('asks for a second press first, and sends nothing until it comes', async () => {
        await show(ready([MINE]));
        await press(deleteButton(article('c-mine')));

        expect(isArmed()).toBe(true);
        expect(sent).toEqual([]);

        await press(deleteButton(article('c-mine')));

        expect(sent).toEqual([{ type: 'task.comment.delete', taskId: 't-32', commentId: 'c-mine' }]);
    });

    it('is not sent when the person backs out with Escape: the next press asks again', async () => {
        await show(ready([MINE]));
        await press(deleteButton(article('c-mine')));
        await act(
            async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        );

        expect(isArmed()).toBe(false);

        await press(deleteButton(article('c-mine')));

        expect(isArmed()).toBe(true);
        expect(sent).toEqual([]);
    });

    it('says why when the daemon refuses', async () => {
        const error = vi.spyOn(toast, 'error');

        answer = () => refused('Comment c-mine does not exist');
        await show(ready([MINE]));
        await press(deleteButton(article('c-mine')));
        await press(deleteButton(article('c-mine')));

        expect(error).toHaveBeenCalledWith({ message: 'Comment c-mine does not exist' });
    });

    it('is a press on one comment only: the other comments of the person are not asked about', async () => {
        await show(ready([MINE, EDITED]));
        await press(deleteButton(article('c-mine')));

        expect(article('c-mine').querySelector('[data-confirming]')).not.toBeNull();
        expect(article('c-edited').querySelector('[data-confirming]')).toBeNull();
    });
});

describe('the composer', () => {
    it('sends the comment trimmed with its button, and is empty again once the daemon took it', async () => {
        await show(ready([]));
        await type('Write a comment', '  Looks good.  ');
        await press(named('Send'));

        expect(sent).toEqual([{ type: 'task.comment.add', taskId: 't-32', body: 'Looks good.' }]);
        expect(editorOf('Write a comment').getMarkdown()).toBe('');
    });

    it('sends with Cmd+Enter and with Ctrl+Enter, and the editor makes no line break of the key', async () => {
        await show(ready([]));
        await type('Write a comment', 'One');

        const event = await key('Write a comment', { key: 'Enter', metaKey: true });

        expect(event.defaultPrevented).toBe(true);
        expect(sent).toEqual([{ type: 'task.comment.add', taskId: 't-32', body: 'One' }]);

        await type('Write a comment', 'Two');
        await key('Write a comment', { key: 'Enter', ctrlKey: true });

        expect(sent.map(input => (input as { body: string }).body)).toEqual(['One', 'Two']);
    });

    it('does not send on a plain Enter, which is a line break', async () => {
        await show(ready([]));
        await type('Write a comment', 'One');
        await key('Write a comment', { key: 'Enter' });

        expect(sent).toEqual([]);
    });

    it('cannot send an empty comment, or one of whitespace, by the button or by the key', async () => {
        await show(ready([]));

        expect(named('Send')!.hasAttribute('disabled')).toBe(true);

        await key('Write a comment', { key: 'Enter', metaKey: true });
        await type('Write a comment', '   ');

        expect(named('Send')!.hasAttribute('disabled')).toBe(true);

        await key('Write a comment', { key: 'Enter', metaKey: true });

        expect(sent).toEqual([]);
    });

    it('does not send the Enter that ends an IME composition', async () => {
        await show(ready([]));
        await type('Write a comment', 'こんにちは');
        await key('Write a comment', { key: 'Enter', metaKey: true, isComposing: true });

        expect(sent).toEqual([]);
    });

    it('keeps the text and says why when the daemon refuses', async () => {
        const error = vi.spyOn(toast, 'error');

        answer = () => refused('The daemon is busy');
        await show(ready([]));
        await type('Write a comment', 'One');
        await press(named('Send'));

        expect(error).toHaveBeenCalledWith({ message: 'The daemon is busy' });
        expect(editorOf('Write a comment').getMarkdown()).toBe('One');
        expect(named('Send')!.hasAttribute('disabled')).toBe(false);
    });

    it('keeps the text as it was typed when a send by the key is refused: the editor made no line break of it', async () => {
        answer = () => refused('The daemon is busy');
        await show(ready([]));
        await type('Write a comment', 'One');
        // The editor's own Mod+Enter is Cmd on a Mac and Ctrl elsewhere (it does not match both at once).
        await key('Write a comment', {
            key: 'Enter',
            ...(/Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
        });

        expect(sent).toHaveLength(1);
        expect(editorOf('Write a comment').getMarkdown()).toBe('One');
        // A paragraph of the text and nothing after it: no hard break.
        expect(editorOf('Write a comment').getJSON().content).toEqual([
            { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        ]);
    });

    it('sends once when the key is pressed again while the first is on its way', async () => {
        let take: (result: CommandResult) => void = () => {};

        answer = () => new Promise(resolve => void (take = resolve));
        await show(ready([]));
        await type('Write a comment', 'One');
        await key('Write a comment', { key: 'Enter', metaKey: true });
        await key('Write a comment', { key: 'Enter', metaKey: true });

        expect(sent).toHaveLength(1);

        await act(async () => take(accepted()));
    });
});

describe('the unsent comment of a task', () => {
    const draftOf = (taskId: string) => store.ui.forProject(store.selectedProjectId!).commentDraft(taskId);
    const closePanel = () => act(async () => reactRoot.render(null));

    it('is kept when the panel goes away, and is in the composer when it opens again', async () => {
        await show(ready([]));
        await type('Write a comment', 'Half a thought');
        await closePanel();

        expect(draftOf('t-32')).toBe('Half a thought');

        await draw();

        expect(editorOf('Write a comment').getMarkdown()).toBe('Half a thought');
        expect(named('Send')!.hasAttribute('disabled')).toBe(false);
    });

    it("belongs to its task: another task's composer starts empty, and the first task's comes back with it", async () => {
        await show(ready([]));
        await type('Write a comment', 'For CAR-32');
        await draw('t-35');

        expect(editorOf('Write a comment').getMarkdown()).toBe('');

        await type('Write a comment', 'For CAR-35');
        await draw('t-32');

        expect(editorOf('Write a comment').getMarkdown()).toBe('For CAR-32');
        expect([draftOf('t-32'), draftOf('t-35')]).toEqual(['For CAR-32', 'For CAR-35']);
    });

    it('is gone once the comment is sent, and the composer is empty when the panel opens again', async () => {
        await show(ready([]));
        await type('Write a comment', 'Looks good.');
        await press(named('Send'));

        expect(draftOf('t-32')).toBe('');

        await closePanel();
        await draw();

        expect(editorOf('Write a comment').getMarkdown()).toBe('');
    });

    it('is kept when the daemon refuses the send', async () => {
        vi.spyOn(toast, 'error');
        answer = () => refused('The daemon is busy');
        await show(ready([]));
        await type('Write a comment', 'One');
        await press(named('Send'));
        await closePanel();
        await draw();

        expect(editorOf('Write a comment').getMarkdown()).toBe('One');
    });

    it('is gone when the person empties the composer', async () => {
        await show(ready([]));
        await type('Write a comment', 'One');
        await act(async () => void editorOf('Write a comment').commands.setContent('', { emitUpdate: true }));

        expect(draftOf('t-32')).toBe('');

        await closePanel();
        await draw();

        expect(editorOf('Write a comment').getMarkdown()).toBe('');
    });

    it('is not made by the edit of a comment, and does not take its text', async () => {
        await show(ready([MINE]));
        await press(named('Edit comment'));
        await type('Edit comment', '!');

        expect(draftOf('t-32')).toBe('');
        expect(editorOf('Write a comment').getMarkdown()).toBe('');
    });
});

describe('the scroll', () => {
    const scrolled = () => vi.mocked(Element.prototype.scrollIntoView).mock.contexts as Element[];

    it("brings the composer into view once the person's own comment is in the list, and not before", async () => {
        answer = () => accepted({ comment: { id: 'c-new' } });
        await show(ready([MINE]));
        await type('Write a comment', 'One');
        await press(named('Send'));

        // The daemon has answered, and the list has not heard of the comment yet.
        expect(scrolled()).toEqual([]);

        await show(ready([MINE, comment('c-new', 'One')]));

        expect(scrolled()).toHaveLength(1);
        expect(scrolled()[0].contains(container.querySelector('[contenteditable][aria-label="Write a comment"]'))).toBe(
            true
        );
    });

    it("brings it into view as well when the list holds the comment before the daemon's answer comes: the read can win the race against the reply", async () => {
        let take: (result: CommandResult) => void = () => {};

        answer = () => new Promise(resolve => void (take = resolve));
        await show(ready([MINE]));
        await type('Write a comment', 'One');
        await press(named('Send'));
        await show(ready([MINE, comment('c-new', 'One')]));

        expect(scrolled()).toEqual([]);

        await act(async () => take(accepted({ comment: { id: 'c-new' } })));

        expect(scrolled()).toHaveLength(1);

        // And it stays done: a later change of the list is not the person's send.
        await show(ready([MINE, comment('c-new', 'One'), comment('c-later', 'Two')]));

        expect(scrolled()).toHaveLength(1);
    });

    it('does it once: the next change of the list does not scroll again', async () => {
        answer = () => accepted({ comment: { id: 'c-new' } });
        await show(ready([MINE]));
        await type('Write a comment', 'One');
        await press(named('Send'));
        await show(ready([MINE, comment('c-new', 'One')]));
        await show(ready([MINE, comment('c-new', 'One'), comment('c-later', 'Two')]));

        expect(scrolled()).toHaveLength(1);
    });

    it('leaves the list where it is when a comment arrives that the person did not send, and when the list loads', async () => {
        await show(ready([MINE]));
        await show(ready([MINE, AGENTS]));
        await show(ready([MINE, AGENTS, EDITED]));

        expect(scrolled()).toEqual([]);
    });

    it('does not scroll for a comment the person edited or deleted', async () => {
        await show(ready([MINE, AGENTS]));
        await press(named('Edit comment'));
        await type('Edit comment', '!');
        await press(named('Save'));
        await show(ready([comment('c-mine', 'Keep the amount in cents.!', { editedAt: 1 }), AGENTS]));
        await show(ready([AGENTS]));

        expect(scrolled()).toEqual([]);
    });
});
