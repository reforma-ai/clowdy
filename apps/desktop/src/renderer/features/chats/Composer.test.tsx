// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { busyEnter } from './busyEnter';
import { Composer } from './Composer';
import { modelStore } from './modelTestKit';

import type { Chat, CommandResult, DocsTree, ProjectFolder, Run, SkillEntry, Task } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const newChat = (id: string): Chat => ({ id, projectId: 'p', title: 'New chat', mode: 'autopilot', createdAt: 0, updatedAt: 0 });
const runWith = (status: Run['status']) => ({ id: 'r-1', status }) as Run;
const accepted: CommandResult = { ok: true, requestId: 'request-1', data: {} };
const refused: CommandResult = { ok: false, requestId: 'request-1', error: { code: 'unavailable', message: 'The daemon cannot be reached' } };

const tasks = [{ id: 't-24', number: 24, key: 'CAR-24', title: 'Rebuild the form as one view' }] as Task[];
const FOLDERS: ProjectFolder[] = [{ id: 'fld_p', path: '/work/p' }];
const docs: DocsTree = [{ folderId: 'fld_p', nodes: [{ path: 'decisions', name: 'decisions', kind: 'dir', children: [{ path: 'decisions/pricing.md', name: 'pricing.md', kind: 'file' }] }] }];
const skill = (name: string, source: SkillEntry['source']): SkillEntry => ({ id: `${ source }:${ name }`, name, source, description: `${ name } skill`, enabled: true, tokens: 20, engines: [] });
const skills = [skill('clowdy:orchestrate', 'system'), skill('user:review', 'user')];

let container: HTMLDivElement;
let root: Root;
let sent: CommandInput[];
// Drafts are remembered per chat for the whole session, so each test gets a chat of its own.
let chat: Chat;
let chatNumber = 0;

/** What the pick lists read: the project's tasks, and the daemon's documents, files and skills. */
const findFiles = async (_projectId: string, query: string) => ['src/booking/index.tsx', 'src/booking/price.ts'].filter(path => path.includes(query)).map(path => ({ folderId: 'fld_p', path }));
const transport = {
    getDocsTree: vi.fn(async (): Promise<DocsTree> => docs),
    getProjectFiles: vi.fn(findFiles),
    getSkills: vi.fn(async () => ({ entries: skills, tokens: 0, warnings: [] })),
};

async function mount(result: CommandResult | Promise<CommandResult>, run?: Run, folders = FOLDERS) {
    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return result;
    });
    const store = { command, transport, skillsRevision: 0, selectedProject: { project: { id: 'p', folders }, taskList: tasks }, ...await modelStore() };

    await act(async () => {
        root.render(
            <RootStoreProvider value={ store as unknown as RootStore }>
                <Composer chat={ chat } run={ run } />
            </RootStoreProvider>
        );
    });
}

const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]')!;
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
const text = () => editor().getText();
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${ label }"]`);

function type(value: string) {
    act(() => {
        editor().commands.insertContent(value);
    });
}

async function press(key: string, shiftKey = false, metaKey = false) {
    await act(async () => {
        field().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, metaKey, bubbles: true, cancelable: true }));
    });
}

beforeEach(() => {
    transport.getProjectFiles.mockImplementation(findFiles);
    transport.getDocsTree.mockImplementation(async () => docs);
    sent = [];
    chat = newChat(`c-${ ++chatNumber }`);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('Composer', () => {
    it('sends the trimmed text to the chat on Enter and empties the field', async () => {
        await mount(accepted);
        type('  Add a cancel button  ');
        await press('Enter');

        expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Add a cancel button', mode: 'steer' }]);
        expect(text()).toBe('');
    });

    it('does not send on Shift+Enter', async () => {
        await mount(accepted);
        type('first line');
        await press('Enter', true);

        expect(sent).toEqual([]);
        expect(text()).toContain('first line');
    });

    it('sends nothing for an empty or blank message', async () => {
        await mount(accepted);
        await press('Enter');
        type('   ');
        await press('Enter');

        expect(sent).toEqual([]);
    });

    it('puts the words back when the daemon refuses the message', async () => {
        await mount(refused);
        type('Add a cancel button');
        await press('Enter');

        expect(sent).toHaveLength(1);
        expect(text()).toBe('Add a cancel button');
    });

    it('does not put the refused words over what was typed since', async () => {
        let refuse!: (result: CommandResult) => void;
        const pending = new Promise<CommandResult>((resolve) => {
            refuse = resolve;
        });

        await mount(pending);
        type('first try');
        await press('Enter');
        type('second try');
        await act(async () => refuse(refused));

        expect(text()).toBe('second try');
    });

    it('sends bold text as markdown', async () => {
        await mount(accepted);
        act(() => {
            editor().commands.insertContent([
                { type: 'text', text: 'Make the ' },
                { type: 'text', text: 'title', marks: [{ type: 'bold' }] },
                { type: 'text', text: ' bigger' },
            ]);
        });

        expect(text()).toBe('Make the title bigger');

        await press('Enter');

        expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Make the **title** bigger', mode: 'steer' }]);
    });

    it('sends with the send button and keeps it off while the field is empty', async () => {
        await mount(accepted);

        expect(button('Send')!.disabled).toBe(true);

        type('Hello');
        expect(button('Send')!.disabled).toBe(false);

        await act(async () => button('Send')!.click());

        expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Hello', mode: 'steer' }]);
    });

    it('puts the caret back in the field after the send button, which is off by then', async () => {
        const elsewhere = document.body.appendChild(document.createElement('input'));

        await mount(accepted);
        // The editor takes the caret a moment after it mounts; let that pass before moving it away.
        await act(async () => {
            await new Promise(requestAnimationFrame);
        });
        type('Hello');
        elsewhere.focus();

        expect(document.activeElement).toBe(elsewhere);

        await act(async () => button('Send')!.click());
        elsewhere.remove();

        expect(document.activeElement).toBe(field());
    });

    it('keeps an unsent draft for the chat when it is shown again', async () => {
        await mount(accepted);
        type('half a thought');
        act(() => root.unmount());
        root = createRoot(container);
        await mount(accepted);

        expect(text()).toBe('half a thought');
    });

    describe('mentions', () => {
        const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
        const optionTexts = () => options().map(option => option.textContent ?? '');

        /** Types into the field and waits for the pick list the text opens. */
        const open = async (typed: string) => {
            await act(async () => {
                editor().commands.focus();
                editor().commands.insertContent(typed);
                await new Promise(requestAnimationFrame);
            });
        };

        const choose = async (label: string) => {
            const option = options().find(candidate => candidate.textContent?.includes(label))!;
            const pointer = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, width: 1, height: 1, pressure: 0.5, detail: 1 };

            await act(async () => {
                option.dispatchEvent(new PointerEvent('pointerdown', pointer));
                option.dispatchEvent(new PointerEvent('pointerup', pointer));
                option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
            });
        };

        it('lists tasks, documents and files after @, and sends a chosen task as its key', async () => {
            await mount(accepted);
            await open('Do @');

            expect(optionTexts()).toEqual([
                expect.stringContaining('CAR-24'),
                expect.stringContaining('pricing.md'),
                expect.stringContaining('index.tsx'),
                expect.stringContaining('price.ts'),
            ]);

            await choose('CAR-24');
            await press('Enter');

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Do CAR-24', mode: 'steer' }]);
        });

        it('narrows the list as the person types and sends a file as @path', async () => {
            await mount(accepted);
            await open('Look at @price');

            expect(optionTexts()).toEqual([expect.stringContaining('price.ts')]);

            await choose('price.ts');
            await press('Enter');

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Look at @src/booking/price.ts', mode: 'steer' }]);
        });

        it('sends a document as @path from the project folder', async () => {
            await mount(accepted);
            await open('Follow @decisions');
            await choose('pricing.md');
            await press('Enter');

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Follow @.clowdy/docs/decisions/pricing.md', mode: 'steer' }]);
        });

        it('sends a document of another folder by its absolute path, and names the folder in the suggestion', async () => {
            transport.getDocsTree.mockImplementation(async () => [...docs, { folderId: 'fld_api', nodes: [{ path: 'endpoints.md', name: 'endpoints.md', kind: 'file' }] }]);
            await mount(accepted, undefined, [...FOLDERS, { id: 'fld_api', path: '/work/api' }]);
            await open('Read @endpoints');

            expect(optionTexts()).toEqual([expect.stringMatching(/endpoints\.md.*api/)]);

            await choose('endpoints.md');
            await press('Enter');

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Read @/work/api/.clowdy/docs/endpoints.md', mode: 'steer' }]);
        });

        it('lists the files of every folder, sends another folder\'s by its absolute path, and names the folder in the suggestion', async () => {
            transport.getProjectFiles.mockImplementation(async () => [{ folderId: 'fld_api', path: 'src/routes/price.ts' }, { folderId: 'fld_p', path: 'src/booking/price.ts' }]);
            await mount(accepted, undefined, [...FOLDERS, { id: 'fld_api', path: '/work/api' }]);
            await open('Compare @price');

            expect(optionTexts()).toEqual([expect.stringMatching(/price\.ts.*api\/src\/routes/), expect.stringMatching(/price\.ts.*p\/src\/booking/)]);

            await choose('api/src/routes');
            // A chosen mention is followed by a space.
            type('and ');
            await open('@');
            await choose('p/src/booking');
            await press('Enter');

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Compare @/work/api/src/routes/price.ts and @src/booking/price.ts', mode: 'steer' }]);
        });

        it('still lists the rest when one source is down', async () => {
            transport.getProjectFiles.mockRejectedValue(new Error('offline'));
            await mount(accepted);
            await open('Do @');

            expect(optionTexts()).toEqual([expect.stringContaining('CAR-24'), expect.stringContaining('pricing.md')]);
        });

        it('lists the person\'s skills after /, not the system ones, and asks for the chosen one in words', async () => {
            await mount(accepted);
            await open('/');

            expect(optionTexts()).toEqual([expect.stringContaining('/review')]);

            await choose('/review');
            await type('the diff');
            await press('Enter');

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Use the skill "review" the diff', mode: 'steer' }]);
        });

        it('asks for the skills again after a read that failed, not once the skills change', async () => {
            transport.getSkills.mockRejectedValueOnce(new Error('offline'));
            await mount(accepted);
            await open('/');
            await open('r');

            expect(optionTexts()).toEqual([expect.stringContaining('/review')]);
        });

        it('sends the message on Enter when the list found nothing, text after the @ included', async () => {
            await mount(accepted);
            await open('Mail me@home or @zzz');

            expect(options()).toEqual([]);

            await press('Enter');

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Mail me@home or @zzz', mode: 'steer' }]);
        });

        it('keeps a mention in the draft when the chat is shown again', async () => {
            await mount(accepted);
            await open('Do @');
            await choose('CAR-24');
            act(() => root.unmount());
            root = createRoot(container);
            await mount(accepted);
            await press('Enter');

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Do CAR-24', mode: 'steer' }]);
        });
    });

    describe('pressing the card', () => {
        const mouseDown = async (target: Element) => {
            const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });

            await act(async () => {
                target.dispatchEvent(event);
            });

            return event;
        };
        // The button row has gaps between its controls: space that is not a control.
        const space = () => button('Send')!.parentElement!.parentElement!;

        it('puts the caret in the text when the press lands on the card\'s own space', async () => {
            await mount(accepted);
            (document.activeElement as HTMLElement | null)?.blur();

            const event = await mouseDown(space());

            expect(event.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(field());
        });

        it('leaves a press on a control to the control', async () => {
            await mount(accepted, runWith('running'));

            expect((await mouseDown(container.querySelector('[role="button"][aria-label="Mode"]')!)).defaultPrevented).toBe(false);
            expect((await mouseDown(button('Stop')!)).defaultPrevented).toBe(false);
        });

        it('leaves a press inside the open mode list to the list', async () => {
            await mount(accepted);

            const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Mode:"]')!;

            await act(async () => {
                trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
                trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
                trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
                trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
                trigger.click();
            });

            const list = document.querySelector('[role="menu"]')!.closest('[data-trigger="MenuTrigger"]')!;

            expect((await mouseDown(list)).defaultPrevented).toBe(false);
        });
    });

    describe('while the orchestrator works', () => {
        it('keeps the mode as it is', async () => {
            await mount(accepted, runWith('running'));

            expect(container.querySelector<HTMLButtonElement>('button[aria-label^="Mode:"]')!.disabled).toBe(true);
        });

        it('lets the mode change when it is not working', async () => {
            await mount(accepted, runWith('succeeded'));

            expect(container.querySelector<HTMLButtonElement>('button[aria-label^="Mode:"]')!.disabled).toBe(false);
        });

        it('turns the send button into Stop while nothing is typed, and Stop cancels the run', async () => {
            await mount(accepted, runWith('running'));

            expect(button('Send')).toBeNull();

            await act(async () => button('Stop')!.click());

            expect(sent).toEqual([{ type: 'run.cancel', runId: 'r-1' }]);
        });

        it('is Send again once something is typed, so a message still reaches the orchestrator', async () => {
            await mount(accepted, runWith('running'));
            type('Use the blue one');

            expect(button('Stop')).toBeNull();

            await act(async () => button('Send')!.click());

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Use the blue one', mode: 'steer' }]);
        });

        it('has no Stop for a run that is over', async () => {
            await mount(accepted, runWith('succeeded'));

            expect(button('Stop')).toBeNull();
            expect(button('Send')).not.toBeNull();
        });
    });

    describe('how a message waits for a busy orchestrator', () => {
        const placeholder = () => field().querySelector('[data-placeholder]')?.getAttribute('data-placeholder');

        afterEach(() => busyEnter.setMode('steer'));

        it('steers the running turn on Enter and queues the message for the next turn on Cmd+Enter, by default', async () => {
            await mount(accepted, runWith('running'));
            type('Use the blue one');
            await press('Enter');
            type('Then the footer');
            await press('Enter', false, true);

            expect(sent).toEqual([
                { type: 'chat.send', chatId: chat.id, text: 'Use the blue one', mode: 'steer' },
                { type: 'chat.send', chatId: chat.id, text: 'Then the footer', mode: 'queue' },
            ]);
            expect(text()).toBe('');
        });

        it('queues on Enter and steers on Cmd+Enter when the setting says to queue', async () => {
            busyEnter.setMode('queue');
            await mount(accepted, runWith('waiting_user'));
            type('Later');
            await press('Enter');
            type('Now');
            await press('Enter', false, true);

            expect(sent.map(input => input.type === 'chat.send' && input.mode)).toEqual(['queue', 'steer']);
        });

        it('sends with the send button the way Enter does', async () => {
            busyEnter.setMode('queue');
            await mount(accepted, runWith('running'));
            type('Later');
            await act(async () => button('Send')!.click());

            expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Later', mode: 'queue' }]);
        });

        it('says the message will wait while the orchestrator works, and not while it waits for its executors', async () => {
            await mount(accepted, runWith('running'));

            expect(placeholder()).toBe('Queue another message…');

            await mount(accepted, runWith('waiting_children'));

            expect(placeholder()).toBe('Write a message…');
        });
    });
});
