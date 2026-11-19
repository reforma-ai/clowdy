// @vitest-environment happy-dom
import { emptyComposerDoc } from '@clowdy/components/RichInput';
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from '@clowdy/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { Composer } from './Composer';
import { newChatDraftKey, saveDraft } from './composerDrafts';
import { modelStore, type ModelStoreOptions } from './modelTestKit';

import type { Chat, CommandResult, QueuedMessage, Run } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts = vi.hoisted(() => ({ error: vi.fn<(options: { message: string }) => void>() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

/*
 * The context ring of the message box: when it is there, what its popover says, and what Compact does. The test build has no MobX
 * observer, so the composer is drawn again by hand where the run changes (the app draws it again as `run.upserted` replaces the run).
 */

const accepted: CommandResult = { ok: true, requestId: 'request-1', data: {} };
const refused: CommandResult = { ok: false, requestId: 'request-1', error: { code: 'conflict', message: 'Some child runs finished that the orchestrator has not read yet. Send it a message first, then compact the chat' } };

const transport = {
    getDocsTree: vi.fn(async () => []),
    getProjectFiles: vi.fn(async () => []),
    getSkills: vi.fn(async () => ({ entries: [], tokens: 0, warnings: [] })),
};

let container: HTMLDivElement;
let root: Root;
let sent: CommandInput[];
let chatNumber = 0;

interface Page {
    /** The chat the composer is on; without one it is the new-chat page. */
    chat?: Chat;
    run?: Run;
    /** What the daemon answers to a command (accepted by default). */
    answer?: (input: CommandInput) => CommandResult | Promise<CommandResult>;
}

async function mount(page: Page = {}, options: ModelStoreOptions = {}) {
    let current = page;
    const store = await modelStore(options);
    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return (current.answer ?? (() => accepted))(input);
    });
    const root$ = { command, transport, skillsRevision: 0, selectedProject: { project: { id: 'p' }, taskList: [] }, ...store } as unknown as RootStore;
    const draw = () => act(async () => {
        root.render(
            <RootStoreProvider value={ root$ }>
                { current.chat
                    ? <Composer chat={ current.chat } run={ current.run } />
                    : <Composer chat={ undefined } run={ undefined } start={ { projectId: 'p', onStarted: () => {} } } /> }
            </RootStoreProvider>
        );
    });

    await draw();

    return {
        /** Shows the composer again on what the store has by now: the run as it changed. */
        update: async (next: Partial<Page>) => {
            current = { ...current, ...next };
            await draw();
        },
    };
}

const ring = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Context usage"]');
const modelPill = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
// The popover has a hidden dismiss button of its own, so the button is found by its words.
const compactButton = () => [...dialog()?.querySelectorAll('button') ?? []].find(button => button.textContent === 'Compact') ?? null;
const stand = () => dialog()?.querySelector<HTMLElement>('[role="button"][aria-disabled]') ?? null;
const meter = () => dialog()!.querySelector<HTMLElement>('[role="meter"]')!;
const arc = () => ring()!.querySelector('circle[stroke-dasharray]');

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

async function openRing() {
    await press(ring());
    await settle();
}

const chatOn = (rest: Partial<Chat> = {}): Chat => ({ id: `c-ring-${ ++chatNumber }`, projectId: 'p', title: 'A chat', mode: 'autopilot', createdAt: 0, updatedAt: 0, engine: 'claude', model: 'opus', effort: 'high', orchestratorRunId: 'r-1', ...rest });
const runOf = (rest: Partial<Run> = {}) => ({ id: 'r-1', status: 'succeeded', engine: 'claude', model: 'opus', effort: 'high', context: { used: 53_000, size: 250_000 }, ...rest }) as Run;
/** A run whose window is 100K tokens, `used` thousand of them taken. */
const filled = (used: number) => runOf({ context: { used: used * 1_000, size: 100_000 } });

const withoutCompact = (agentId: string): ModelStoreOptions => ({
    change: (data) => {
        delete data.agents.find(agent => agent.id === agentId)!.canCompact;
    },
});

beforeEach(() => {
    localStorage.clear();
    saveDraft(newChatDraftKey('p'), emptyComposerDoc());
    toasts.error.mockClear();
    sent = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('the ring', () => {
    it('is drawn when the orchestrator has a reading, right before the model pill', async () => {
        await mount({ chat: chatOn(), run: runOf() });

        expect(ring()).not.toBeNull();
        expect(ring()!.getAttribute('aria-label')).toBe('Context usage, 21% full');
        expect(ring()!.getAttribute('aria-expanded')).toBe('false');
        expect(modelPill()!.previousElementSibling).toBe(ring());
    });

    it('is not drawn on the new-chat page', async () => {
        await mount();

        expect(ring()).toBeNull();
        expect(modelPill()).not.toBeNull();
    });

    it('is not drawn for a chat that has no orchestrator yet', async () => {
        await mount({ chat: chatOn({ orchestratorRunId: undefined }), run: undefined });

        expect(ring()).toBeNull();
    });

    it('is not drawn when the run has no reading, as for Cursor, which sends none', async () => {
        await mount({ chat: chatOn({ engine: 'cursor', model: 'default' }), run: runOf({ engine: 'cursor', context: undefined }) });

        expect(ring()).toBeNull();
        expect(modelPill()).not.toBeNull();
    });

    it('draws the percent as an arc and no arc for an empty window', async () => {
        const { update } = await mount({ chat: chatOn(), run: runOf() });

        expect(arc()!.getAttribute('stroke-dasharray')).toBe('21 79');

        await update({ run: runOf({ context: { used: 0, size: 250_000 } }) });

        expect(ring()!.getAttribute('aria-label')).toBe('Context usage, 0% full');
        expect(arc()).toBeNull();
    });

    it('stays for a chat whose orchestrator has finished: the last reading is kept', async () => {
        await mount({ chat: chatOn(), run: runOf({ status: 'failed' }) });

        expect(ring()).not.toBeNull();
    });
});

describe('its tooltip', () => {
    const tooltip = () => document.querySelector('[role="tooltip"]');
    /** Moves focus to the ring the way a keyboard does, which shows a tooltip at once (a pointer waits for its delay). */
    const focusRing = () => act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        ring()!.focus();
    });

    it('says what the ring is and how full, as its label does, since the ring is only an arc', async () => {
        await mount({ chat: chatOn(), run: runOf() });
        await focusRing();
        await settle();

        expect(tooltip()?.textContent).toBe('Context usage, 21% full');
        expect(ring()!.getAttribute('aria-describedby')).toBe(tooltip()!.id);
    });

    it('is gone when the popover opens, and does not come back over it', async () => {
        await mount({ chat: chatOn(), run: runOf() });
        await focusRing();
        await settle();

        expect(tooltip()).not.toBeNull();

        await openRing();

        expect(dialog()).not.toBeNull();
        expect(tooltip()).toBeNull();
    });

    it('does not open over the popover when the press came before its delay was up', async () => {
        await mount({ chat: chatOn(), run: runOf() });

        // A pointer arrives on the ring (the tooltip waits half a second), and the press comes before that.
        await act(async () => {
            document.dispatchEvent(new PointerEvent('pointermove', pointer));
            ring()!.dispatchEvent(new PointerEvent('pointerover', pointer));
        });
        await openRing();
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 650));
        });

        expect(dialog()).not.toBeNull();
        expect(tooltip()).toBeNull();
    });
});

describe('its popover', () => {
    it('says the context usage, the percent full and the tokens of the window, with one bar', async () => {
        await mount({ chat: chatOn(), run: runOf() });
        await openRing();

        expect(ring()!.getAttribute('aria-expanded')).toBe('true');
        expect(dialog()!.getAttribute('aria-label')).toBe('Context usage');
        expect(dialog()!.textContent).toContain('Context usage');
        expect(dialog()!.textContent).toContain('21% full');
        expect(dialog()!.textContent).toContain('~53K / 250K');
        expect(dialog()!.querySelectorAll('[role="meter"]')).toHaveLength(1);
        expect(meter().getAttribute('aria-valuenow')).toBe('21');
        expect(meter().querySelector<HTMLElement>('div')!.style.width).toBe('21%');
    });

    it.each([
        [79, 'normal'],
        [80, 'warning'],
        [89, 'warning'],
        [90, 'danger'],
        [100, 'danger'],
    ])('tones the ring and the bar at %i%% as %s', async (percent, tone) => {
        await mount({ chat: chatOn(), run: filled(percent) });

        expect(ring()!.querySelector('svg')!.getAttribute('data-tone')).toBe(tone);

        await openRing();

        expect(meter().getAttribute('data-tone')).toBe(tone);
        expect(dialog()!.textContent).toContain(`${ percent }% full`);
    });

    it('keeps a window that is over full at 100%', async () => {
        await mount({ chat: chatOn(), run: runOf({ context: { used: 260_000, size: 200_000 } }) });
        await openRing();

        expect(ring()!.getAttribute('aria-label')).toBe('Context usage, 100% full');
        expect(dialog()!.textContent).toContain('~260K / 200K');
    });

    it('follows the run as its reading changes, with the popover open', async () => {
        const { update } = await mount({ chat: chatOn(), run: runOf() });
        await openRing();

        await update({ run: runOf({ context: { used: 200_000, size: 250_000 } }) });

        expect(dialog()).not.toBeNull();
        expect(ring()!.getAttribute('aria-label')).toBe('Context usage, 80% full');
        expect(dialog()!.textContent).toContain('80% full');
        expect(dialog()!.textContent).toContain('~200K / 250K');
        expect(meter().getAttribute('data-tone')).toBe('warning');

        // Compacted: the agent reports less, and the tone goes back.
        await update({ run: runOf({ context: { used: 25_000, size: 250_000 } }) });

        expect(ring()!.getAttribute('aria-label')).toBe('Context usage, 10% full');
        expect(dialog()!.textContent).toContain('~25K / 250K');
        expect(meter().getAttribute('data-tone')).toBe('normal');
    });

    it('goes away with the reading', async () => {
        const { update } = await mount({ chat: chatOn(), run: runOf() });

        await update({ run: runOf({ context: undefined }) });

        expect(ring()).toBeNull();
    });
});

describe('Compact', () => {
    it.each(['claude', 'codex'])('is offered for %s, which can compact its conversation', async (engine) => {
        await mount({ chat: chatOn({ engine }), run: runOf({ engine }) });
        await openRing();

        expect(compactButton()!.textContent).toBe('Compact');
        expect(compactButton()!.disabled).toBe(false);
    });

    it('is not offered for an agent that cannot, which still has the readout', async () => {
        await mount({ chat: chatOn({ engine: 'cursor', model: 'default' }), run: runOf({ engine: 'cursor' }) });
        await openRing();

        expect(dialog()!.textContent).toContain('21% full');
        expect(compactButton()).toBeNull();
    });

    it('is not offered when the daemon does not say the agent can', async () => {
        await mount({ chat: chatOn(), run: runOf() }, withoutCompact('claude'));
        await openRing();

        expect(dialog()!.textContent).toContain('~53K / 250K');
        expect(compactButton()).toBeNull();
    });

    it('asks the chat\'s own agent, and the run\'s for a chat from before chats had one', async () => {
        await mount({ chat: chatOn({ engine: undefined }), run: runOf({ engine: 'codex' }) }, withoutCompact('claude'));
        await openRing();

        expect(compactButton()).not.toBeNull();
    });

    it('is not offered while the agents are not known yet', async () => {
        await mount({ chat: chatOn(), run: runOf() }, { agentsLoading: true });
        await openRing();

        expect(dialog()!.textContent).toContain('21% full');
        expect(compactButton()).toBeNull();
    });

    it('sends chat.compact for the chat and closes the popover', async () => {
        const chat = chatOn();

        await mount({ chat, run: runOf() });
        await openRing();
        await press(compactButton());
        await settle();

        expect(sent).toEqual([{ type: 'chat.compact', chatId: chat.id }]);
        expect(dialog()).toBeNull();
        expect(ring()!.getAttribute('aria-expanded')).toBe('false');
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('is pending while the command is on its way, then closes the popover', async () => {
        let answer!: (result: CommandResult) => void;
        const onItsWay = () => new Promise<CommandResult>((resolve) => {
            answer = resolve;
        });

        await mount({ chat: chatOn(), run: runOf(), answer: onItsWay });
        await openRing();
        await press(compactButton());

        expect(sent).toHaveLength(1);
        expect(dialog()).not.toBeNull();
        expect(compactButton()!.hasAttribute('data-pending')).toBe(true);

        // A second press while it is pending sends nothing.
        await press(compactButton());

        expect(sent).toHaveLength(1);

        await act(async () => answer(accepted));
        await settle();

        expect(dialog()).toBeNull();
    });

    it('shows the daemon\'s refusal as the usual toast and closes the popover', async () => {
        await mount({ chat: chatOn(), run: runOf(), answer: () => refused });
        await openRing();
        await press(compactButton());
        await settle();

        expect(toasts.error).toHaveBeenCalledWith({ message: refused.ok ? '' : refused.error.message });
        expect(dialog()).toBeNull();
    });

    it.each(TERMINAL_RUN_STATUSES)('is on when the orchestrator has ended as %s', async (status) => {
        await mount({ chat: chatOn(), run: runOf({ status }) });
        await openRing();

        expect(stand()).toBeNull();
        expect(compactButton()!.disabled).toBe(false);
    });

    describe('while the orchestrator works', () => {
        const caption = 'Waits in the queue until the agent finishes.';

        it.each(ACTIVE_RUN_STATUSES)('is on when the run is %s, and says it waits in the queue until the agent finishes', async (status) => {
            const chat = chatOn();

            await mount({ chat, run: runOf({ status }) });
            await openRing();

            expect(stand()).toBeNull();
            expect(compactButton()!.disabled).toBe(false);
            expect(dialog()!.textContent).toContain(caption);

            await press(compactButton());
            await settle();

            expect(sent).toEqual([{ type: 'chat.compact', chatId: chat.id }]);
            expect(dialog()).toBeNull();
        });

        it('says nothing of the queue once the orchestrator has finished', async () => {
            const { update } = await mount({ chat: chatOn(), run: runOf({ status: 'running' }) });
            await openRing();

            expect(dialog()!.textContent).toContain(caption);

            await update({ run: runOf({ status: 'succeeded' }) });

            expect(dialog()!.textContent).not.toContain(caption);
            expect(compactButton()!.disabled).toBe(false);
        });

        it('is off while a compact item waits in the queue, and says so when the stand-in has the focus', async () => {
            const queued: QueuedMessage = { id: 'q-1', mode: 'queue', command: 'compact', text: 'Compact the conversation', content: '/compact', createdAt: 0 };

            await mount({ chat: chatOn({ queue: [queued] }), run: runOf({ status: 'running' }) });
            await openRing();

            expect(stand()!.getAttribute('aria-label')).toBe('Compact');
            expect(compactButton()!.disabled).toBe(true);
            expect(dialog()!.textContent).not.toContain(caption);

            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                stand()!.focus();
            });
            await settle();

            expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Compact is in the queue');

            await press(compactButton());
            await settle();

            expect(sent).toEqual([]);
        });

        it('still has the readout', async () => {
            await mount({ chat: chatOn(), run: runOf({ status: 'running' }) });
            await openRing();

            expect(dialog()!.textContent).toContain('21% full');
        });
    });
});
