// @vitest-environment happy-dom
import { emptyComposerDoc } from '@clowdy/components/RichInput';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { Composer } from './Composer';
import { saveDraft } from './composerDrafts';
import { readRemembered, writeRemembered } from './modelSelection';
import { modelStore, type ModelStoreOptions } from './modelTestKit';

import type { AgentModels, Chat, CommandResult, Run } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts = vi.hoisted(() => ({ error: vi.fn<(options: { message: string }) => void>() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

/*
 * The model picker in the composer: what a first message creates the chat with, what a pick in a chat sends, and what is remembered.
 * The test build has no MobX observer, so the composer is drawn again by hand where the store or the chat changes.
 */

const accepted = (data: unknown = {}): CommandResult => ({ ok: true, requestId: 'request-1', data });
const refused: CommandResult = { ok: false, requestId: 'request-1', error: { code: 'conflict', message: 'The provider of a chat is fixed once its first message was sent' } };

const transport = {
    getDocsTree: vi.fn(async () => []),
    getProjectFiles: vi.fn(async () => []),
    getSkills: vi.fn(async () => ({ entries: [], tokens: 0, warnings: [] })),
};

let container: HTMLDivElement;
let root: Root;
let sent: CommandInput[];
let started: string[];
let chatNumber = 0;
let draw: () => Promise<void>;
let store: Awaited<ReturnType<typeof modelStore>>;

interface Page {
    /** The chat the composer is on; without one it is the new-chat page. */
    chat?: Chat;
    run?: Run;
    /** What the daemon answers to each command; a made chat carries the choice it was asked for. */
    answer?: (input: CommandInput) => CommandResult;
    /** The project of the new-chat page (default `p`). */
    projectId?: string;
}

/** A chat as the daemon makes it from `chat.create`. */
const madeFrom = (input: CommandInput): Chat => ({ id: 'c-new', projectId: 'p', title: 'New chat', mode: 'autopilot', createdAt: 0, updatedAt: 0, ...(input.type === 'chat.create' && { engine: input.engine, model: input.model, effort: input.effort }) });

async function mount(page: Page = {}, options: ModelStoreOptions = {}) {
    let current = page;

    store = await modelStore(options);

    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return (current.answer ?? ((next: CommandInput) => (next.type === 'chat.create' ? accepted({ chat: madeFrom(next) }) : accepted())))(input);
    });
    const root$ = { command, transport, skillsRevision: 0, selectedProject: { project: { id: 'p' }, taskList: [] }, ...store } as unknown as RootStore;

    draw = () => act(async () => {
        root.render(
            <RootStoreProvider value={ root$ }>
                { current.chat
                    ? <Composer chat={ current.chat } run={ current.run } />
                    : <Composer chat={ undefined } run={ undefined } start={ { projectId: current.projectId ?? 'p', onStarted: chatId => started.push(chatId) } } /> }
            </RootStoreProvider>
        );
    });

    await draw();

    return {
        /** Shows the composer again on what the store has by now: another chat, or the same one as it changed. */
        update: async (next: Partial<Page>) => {
            current = { ...current, ...next };
            await draw();
        },
    };
}

const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]')!;
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const selectModel = () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Select model"]')!;
const slider = () => dialog()!.querySelector<HTMLElement>('[role="slider"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const optionNamed = (name: string) => options().find(option => option.textContent === name)!;
const headers = () => [...document.querySelectorAll('[role="listbox"] header')].map(header => header.textContent);
const stored = () => localStorage.getItem('clowdy:model-choice');

function type(value: string) {
    act(() => {
        editor().commands.insertContent(value);
    });
}

const pressEnter = () => act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
});

const pointer = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, width: 1, height: 1, pressure: 0.5, detail: 1 };

const press = (element: Element | null | undefined) => act(async () => {
    element!.dispatchEvent(new PointerEvent('pointerdown', pointer));
    element!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    element!.dispatchEvent(new PointerEvent('pointerup', pointer));
    element!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
});

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
});

const key = (target: Element, name: string) => act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
});

async function openPicker() {
    await press(trigger());
    await settle();
}

/** Picks a model by its name in the open popover's list, and leaves the popover open on its face. */
async function pickModel(name: string) {
    await press(selectModel());
    await press(optionNamed(name));
}

/** A chat that has a choice of its own, with or without its orchestrator started. */
const chatOn = (rest: Partial<Chat> = {}): Chat => ({ id: `c-model-${ ++chatNumber }`, projectId: 'p', title: 'A chat', mode: 'autopilot', createdAt: 0, updatedAt: 0, engine: 'claude', model: 'opus', effort: 'high', orchestratorRunId: 'r-1', ...rest });
const runOf = (rest: Partial<Run> = {}) => ({ id: 'r-1', status: 'succeeded', engine: 'claude', model: 'opus', effort: 'high', ...rest }) as Run;

beforeEach(() => {
    localStorage.clear();
    saveDraft('@new-chat', emptyComposerDoc());
    toasts.error.mockClear();
    sent = [];
    started = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('on the new-chat page', () => {
    it('starts on the provider\'s default model and level when nothing was picked before', async () => {
        await mount();

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: Opus 5.5 · High');
    });

    it('starts the chat on what the picker holds: the provider, the model and the level', async () => {
        await mount();
        await openPicker();
        await pickModel('GPT-6.2 Sol');
        await key(slider(), 'End');
        type('Build the thing');
        await pressEnter();

        expect(sent).toEqual([
            { type: 'chat.create', projectId: 'p', mode: 'autopilot', engine: 'codex', model: 'gpt-6.2-sol', effort: 'ultra' },
            { type: 'chat.send', chatId: 'c-new', text: 'Build the thing' },
        ]);
        expect(started).toEqual(['c-new']);
    });

    it('creates the chat with the starting choice when nothing was touched', async () => {
        await mount();
        type('Build the thing');
        await pressEnter();

        expect(sent[0]).toEqual({ type: 'chat.create', projectId: 'p', mode: 'autopilot', engine: 'claude', model: 'opus', effort: 'high' });
    });

    it('leaves out the level of a model that has none', async () => {
        await mount();
        await openPicker();
        await pickModel('Haiku 4.5');
        type('Build the thing');
        await pressEnter();

        expect(sent[0]).toEqual({ type: 'chat.create', projectId: 'p', mode: 'autopilot', engine: 'claude', model: 'claude-haiku-4-5-20251001' });
    });

    it('remembers every pick, the level too, and starts the next new chat on it', async () => {
        await mount();
        await openPicker();
        await pickModel('Fable 5.2');
        await key(slider(), 'Home');

        expect(readRemembered()).toEqual({ engine: 'claude', models: { claude: 'fable' }, efforts: { 'claude/fable': 'low' } });

        act(() => root.unmount());
        root = createRoot(container);
        await mount();

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: Fable 5.2 · Low');

        type('Next one');
        await pressEnter();

        expect(sent[0]).toEqual({ type: 'chat.create', projectId: 'p', mode: 'autopilot', engine: 'claude', model: 'fable', effort: 'low' });
    });

    it('starts on the provider that was picked last, with its last model and level', async () => {
        writeRemembered({ engine: 'codex', models: { codex: 'gpt-6-luna' }, efforts: { 'codex/gpt-6-luna': 'max' } });
        await mount();

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: GPT-6 Luna · Max');

        type('Go');
        await pressEnter();

        expect(sent[0]).toEqual({ type: 'chat.create', projectId: 'p', mode: 'autopilot', engine: 'codex', model: 'gpt-6-luna', effort: 'max' });
    });

    it('starts on the first provider that can be used when the remembered one cannot', async () => {
        writeRemembered({ engine: 'codex', models: {}, efforts: {} });
        await mount({}, {
            change: (data) => {
                data.agents.find(agent => agent.id === 'codex')!.enabled = false;
            },
        });

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: Opus 5.5 · High');
    });

    it('looks again at the models as they arrive until something is picked, and never after', async () => {
        const arrive: (() => void)[] = [];
        const read = (_agentId: string, fixture: AgentModels) => new Promise<AgentModels>((resolve) => {
            arrive.push(() => resolve(fixture));
        });
        const { update } = await mount({}, { read, preload: false });

        // Nothing is known yet: the provider only, with a spinner.
        expect(trigger()!.textContent).toBe('Model');
        expect(trigger()!.querySelector('[role="status"]')).not.toBeNull();

        await act(async () => arrive.forEach(resolve => resolve()));
        await update({});

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: Opus 5.5 · High');

        await openPicker();
        await pickModel('Sonnet 5.5');
        writeRemembered({ engine: 'codex', models: { codex: 'gpt-6-luna' }, efforts: {} });
        await update({});

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: Sonnet 5.5 · High');
    });

    it('keeps what was remembered when the page opened, whatever is written to the memory meanwhile, until something is picked', async () => {
        writeRemembered({ engine: 'codex', models: { codex: 'gpt-6-luna' }, efforts: { 'codex/gpt-6-luna': 'max' } });

        const { update } = await mount();

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: GPT-6 Luna · Max');

        writeRemembered({ engine: 'claude', models: { claude: 'fable' }, efforts: { 'claude/fable': 'low' } });
        await update({});

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: GPT-6 Luna · Max');
    });

    it('lets the first message go while the models are still being read, on the provider alone', async () => {
        await mount({}, { read: () => new Promise<AgentModels>(() => undefined), preload: false });
        type('Build the thing');
        await pressEnter();

        expect(sent[0]).toEqual({ type: 'chat.create', projectId: 'p', mode: 'autopilot', engine: 'claude' });
    });

    it('lists a section for each provider that is on, in the order Claude Code, Codex, Cursor', async () => {
        await mount();
        await openPicker();
        await press(selectModel());

        expect(headers()).toEqual(['Claude Code', 'Codex', 'Cursor']);
    });

    it('leaves out a provider that is off, and has no sections with one', async () => {
        await mount({}, {
            change: (data) => {
                for (const agent of data.agents) agent.enabled = agent.id === 'codex';
            },
        });

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: GPT-6.2 Sol · Low');

        await openPicker();
        await press(selectModel());

        expect(headers()).toEqual([]);
        expect(options().length).toBeGreaterThan(0);
        expect(options().every(option => option.getAttribute('data-engine') === 'codex')).toBe(true);
    });

    it('leaves out a provider that is not installed', async () => {
        await mount({}, {
            change: (data) => {
                data.agents.find(agent => agent.id === 'cursor')!.status = 'missing';
            },
        });
        await openPicker();
        await press(selectModel());

        expect(headers()).toEqual(['Claude Code', 'Codex']);
    });

    describe('with no provider on', () => {
        const allOff = {
            change: (data: Parameters<NonNullable<ModelStoreOptions['change']>>[0]) => {
                for (const agent of data.agents) agent.enabled = false;
            },
        };

        it('shows a disabled pill in the place of the picker, and says what to do', async () => {
            await mount({}, allOff);

            expect(trigger()).toBeNull();
            expect(container.querySelector<HTMLButtonElement>('button[aria-label="No provider"]')!.disabled).toBe(true);
            expect(container.querySelector('[role="button"][aria-disabled][aria-label="Model"]')).not.toBeNull();
        });

        it('says nothing of it while the agents are still being read', async () => {
            await mount({}, { agentsLoading: true });

            expect(container.querySelector('button[aria-label="No provider"]')).toBeNull();
            expect(container.querySelector('[role="button"][aria-label="Model"]')).toBeNull();
            expect(trigger()).toBeNull();
        });

        it('sends nothing, and keeps the words', async () => {
            await mount({}, allOff);
            type('Build the thing');
            await pressEnter();

            expect(sent).toEqual([]);
            expect(editor().getText()).toBe('Build the thing');
            expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true);
        });

        it('keeps a chat\'s own choice in its page, whatever is on', async () => {
            const { update } = await mount({ chat: chatOn(), run: runOf() }, allOff);

            // The chat's own provider is read when the composer first asks, and the composer is drawn again as the list comes.
            await update({});

            expect(trigger()!.getAttribute('aria-label')).toBe('Model: Opus 5.5 · High');
        });
    });

    describe('after a first message failed', () => {
        const failsToSend = (input: CommandInput) => (input.type === 'chat.send' ? refused : input.type === 'chat.create' ? accepted({ chat: madeFrom(input) }) : accepted());

        it('sends a pick of another provider to the chat it made, with the provider, and the retry goes to that chat', async () => {
            await mount({ answer: failsToSend });
            type('Build the thing');
            await pressEnter();
            await openPicker();
            await pickModel('GPT-6 Sol');

            expect(sent.map(input => input.type)).toEqual(['chat.create', 'chat.send', 'chat.setModel']);
            expect(sent[2]).toEqual({ type: 'chat.setModel', chatId: 'c-new', engine: 'codex', model: 'gpt-6-sol', effort: 'high' });
            expect(trigger()!.getAttribute('aria-label')).toBe('Model: GPT-6 Sol · High');

            // No orchestrator has started, so the provider may still change.
            await press(selectModel());

            expect(headers()).toEqual(['Claude Code', 'Codex', 'Cursor']);
        });

        it('keeps the chat it made on its own choice, and does not call it a page with no provider, when every provider is switched off after', async () => {
            const { update } = await mount({ answer: failsToSend });

            type('Build the thing');
            await pressEnter();

            for (const agent of store.agents) agent.enabled = false;

            await update({});

            expect(container.querySelector('button[aria-label="No provider"]')).toBeNull();
            // Its provider lists nothing now: the model shows by its id.
            expect(trigger()!.getAttribute('aria-label')).toBe('Model: opus');
        });

        it('does not carry the chat it made into the new-chat page of another project', async () => {
            const { update } = await mount({ answer: failsToSend });

            type('Build the thing');
            await pressEnter();

            expect(sent.map(input => input.type)).toEqual(['chat.create', 'chat.send']);

            await update({ projectId: 'q' });
            sent.length = 0;
            type('Another thing');
            await pressEnter();

            // The new page of the other project makes a chat of its own, and a pick there is not sent to the first project's chat.
            expect(sent.map(input => input.type)).toEqual(['chat.create', 'chat.send']);
            expect(sent[0]).toMatchObject({ type: 'chat.create', projectId: 'q' });
        });

        it('leaves the provider out of a pick of another model of the same one', async () => {
            await mount({ answer: failsToSend });
            type('Build the thing');
            await pressEnter();
            await openPicker();
            await pickModel('Fable 5.2');

            expect(sent[2]).toEqual({ type: 'chat.setModel', chatId: 'c-new', model: 'fable', effort: 'high' });
        });
    });
});

describe('in a chat', () => {
    it('holds the chat\'s own choice, as the store has it by now', async () => {
        const chat = chatOn({ model: 'fable', effort: 'max' });
        const { update } = await mount({ chat, run: runOf() });

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: Fable 5.2 · Max');

        await update({ chat: { ...chat, model: 'sonnet', effort: 'low' } });

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: Sonnet 5.5 · Low');
    });

    it('sends a picked model to the chat with its level, and not the provider', async () => {
        const chat = chatOn();

        await mount({ chat, run: runOf() });
        await openPicker();
        await pickModel('Fable 5.2');

        expect(sent).toEqual([{ type: 'chat.setModel', chatId: chat.id, model: 'fable', effort: 'high' }]);
    });

    it('sends a model with no levels with no level, to clear the one the chat had', async () => {
        const chat = chatOn();

        await mount({ chat, run: runOf() });
        await openPicker();
        await pickModel('Haiku 4.5');

        expect(sent).toEqual([{ type: 'chat.setModel', chatId: chat.id, model: 'claude-haiku-4-5-20251001', effort: null }]);
    });

    it('sends a moved slider as the chat\'s model with the new level', async () => {
        const chat = chatOn();

        await mount({ chat, run: runOf() });
        await openPicker();
        await key(slider(), 'End');

        expect(sent).toEqual([{ type: 'chat.setModel', chatId: chat.id, model: 'opus', effort: 'max' }]);
    });

    it('sends nothing for the model already in force', async () => {
        await mount({ chat: chatOn(), run: runOf() });
        await openPicker();
        await pickModel('Opus 5.5');

        expect(sent).toEqual([]);
    });

    it('remembers a pick the daemon took, the level too', async () => {
        const chat = chatOn();
        const { update } = await mount({ chat, run: runOf() });

        await openPicker();
        await pickModel('Sonnet 5.5');
        // The chat comes back from the daemon on the new model.
        await update({ chat: { ...chat, model: 'sonnet' } });
        await key(slider(), 'Home');

        expect(readRemembered()).toEqual({ engine: 'claude', models: { claude: 'sonnet' }, efforts: { 'claude/sonnet': 'low' } });
    });

    it('says what the daemon refused, and remembers nothing of it', async () => {
        await mount({ chat: chatOn(), run: runOf(), answer: () => refused });
        await openPicker();
        await pickModel('Sonnet 5.5');

        expect(toasts.error).toHaveBeenCalledWith({ message: 'The provider of a chat is fixed once its first message was sent' });
        expect(stored()).toBeNull();
    });

    it('lists the models of the chat\'s provider alone, with no sections, once its orchestrator has started', async () => {
        await mount({ chat: chatOn({ engine: 'codex', model: 'gpt-6-sol', effort: 'high' }), run: runOf({ engine: 'codex' }) });
        await openPicker();
        await press(selectModel());

        expect(headers()).toEqual([]);
        expect(options().length).toBeGreaterThan(0);
        expect(options().every(option => option.getAttribute('data-engine') === 'codex')).toBe(true);
    });

    it('can change the provider too while there is no orchestrator yet, and sends it', async () => {
        const chat = chatOn({ orchestratorRunId: undefined });

        await mount({ chat });
        await openPicker();
        await press(selectModel());

        expect(headers()).toEqual(['Claude Code', 'Codex', 'Cursor']);

        await press(optionNamed('GPT-6.2 Sol'));

        expect(sent).toEqual([{ type: 'chat.setModel', chatId: chat.id, engine: 'codex', model: 'gpt-6.2-sol', effort: 'high' }]);
    });

    it('is not held back while the orchestrator works, and says the pick applies from the next message', async () => {
        await mount({ chat: chatOn(), run: runOf({ status: 'running' }) });

        expect(trigger()!.disabled).toBe(false);

        await openPicker();

        expect(dialog()!.textContent).toContain('Applies from the next message');

        await pickModel('Fable 5.2');

        expect(sent).toEqual([expect.objectContaining({ type: 'chat.setModel', model: 'fable' })]);
    });

    it('says nothing of the next message when the orchestrator is not working', async () => {
        await mount({ chat: chatOn(), run: runOf({ status: 'succeeded' }) });
        await openPicker();

        expect(dialog()!.textContent).not.toContain('Applies from the next message');
    });

    it('shows a model the provider no longer lists by its id', async () => {
        await mount({ chat: chatOn({ model: 'claude-sonnet-3-7' }), run: runOf({ model: 'claude-sonnet-3-7' }) });

        expect(trigger()!.getAttribute('aria-label')).toBe('Model: claude-sonnet-3-7');
    });

    describe('from before chats had a choice of their own', () => {
        it('shows what the orchestrator started on', async () => {
            await mount({ chat: chatOn({ engine: undefined, model: undefined, effort: undefined }), run: runOf({ engine: 'codex', model: 'gpt-6-sol', effort: 'xhigh' }) });

            expect(trigger()!.getAttribute('aria-label')).toBe('Model: GPT-6 Sol · Extra high');
        });

        it('shows nothing when there is no orchestrator either', async () => {
            await mount({ chat: chatOn({ engine: undefined, model: undefined, effort: undefined, orchestratorRunId: undefined }) });

            expect(trigger()).toBeNull();
            expect(container.querySelector('button[aria-haspopup="listbox"]')).not.toBeNull();
        });

        it('sends a pick as it does for any chat', async () => {
            const chat = chatOn({ engine: undefined, model: undefined, effort: undefined });

            await mount({ chat, run: runOf({ engine: 'claude', model: 'opus', effort: 'high' }) });
            await openPicker();
            await pickModel('Fable 5.2');

            expect(sent).toEqual([{ type: 'chat.setModel', chatId: chat.id, model: 'fable', effort: 'high' }]);
        });
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

    it('leaves a press on the pill to the pill', async () => {
        await mount({ chat: chatOn(), run: runOf() });

        expect((await mouseDown(trigger()!)).defaultPrevented).toBe(false);
    });

    it('leaves a press inside the open popover to the popover, and does not move the caret to the text', async () => {
        await mount({ chat: chatOn(), run: runOf() });
        await openPicker();
        (document.activeElement as HTMLElement | null)?.blur();

        const event = await mouseDown(dialog()!);

        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).not.toBe(field());

        await press(selectModel());

        expect((await mouseDown(optionNamed('Fable 5.2'))).defaultPrevented).toBe(false);
    });
});
