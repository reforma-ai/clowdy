// @vitest-environment happy-dom
import { emptyComposerDoc } from '@clowdy/components/RichInput';
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from '@clowdy/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RootStore, RootStoreProvider } from '../../stores';
import { Composer } from './Composer';
import { newChatDraftKey, saveDraft } from './composerDrafts';
import { type ModelStoreOptions, modelStore } from './modelTestKit';

import type { Chat, CommandResult, QueuedMessage, Run } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts = vi.hoisted(() => ({ error: vi.fn<(options: { message: string }) => void>() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

/*
 * The context ring of the message box: when it is there, what its tooltip says, and what pressing it does. The test build has no MobX
 * observer, so the composer is drawn again by hand where the run changes (the app draws it again as `run.upserted` replaces the run).
 */

const accepted: CommandResult = { ok: true, requestId: 'request-1', data: {} };
const refused: CommandResult = {
    ok: false,
    requestId: 'request-1',
    error: {
        code: 'conflict',
        message: 'The orchestrator is waiting for background work. Compact the chat when it has finished',
    },
};

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
    const root$ = {
        command,
        transport,
        skillsRevision: 0,
        selectedProject: { project: { id: 'p', folders: [{ id: 'f1', path: '/Users/dev/web' }] }, taskList: [] },
        ...store,
    } as unknown as RootStore;
    const draw = () =>
        act(async () => {
            root.render(
                <RootStoreProvider value={root$}>
                    {current.chat ? (
                        <Composer chat={current.chat} run={current.run} />
                    ) : (
                        <Composer chat={undefined} run={undefined} start={{ projectId: 'p', onStarted: () => {} }} />
                    )}
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

const ring = () =>
    container.querySelector<HTMLElement>('[aria-label^="Compact context"], [aria-label^="Context usage"]');
const modelPill = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]');
const tooltip = () => document.querySelector('[role="tooltip"]');
const meter = () => tooltip()?.querySelector<HTMLElement>('[role="meter"]');
const arc = () => ring()!.querySelector('circle[stroke-dasharray]');

const pointer = {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    width: 1,
    height: 1,
    pressure: 0.5,
    detail: 1,
};

const press = (element: Element | null | undefined) =>
    act(async () => {
        element!.dispatchEvent(new PointerEvent('pointerdown', pointer));
        element!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        element!.dispatchEvent(new PointerEvent('pointerup', pointer));
        element!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    });

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
    });

async function focusRing() {
    await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        ring()!.focus();
    });
    await settle();
}

const chatOn = (rest: Partial<Chat> = {}): Chat => ({
    id: `c-ring-${++chatNumber}`,
    projectId: 'p',
    title: 'A chat',
    mode: 'autopilot',
    createdAt: 0,
    updatedAt: 0,
    engine: 'claude',
    model: 'opus',
    effort: 'high',
    orchestratorRunId: 'r-1',
    ...rest,
});
const runOf = (rest: Partial<Run> = {}) =>
    ({
        id: 'r-1',
        status: 'succeeded',
        engine: 'claude',
        model: 'opus',
        effort: 'high',
        context: { used: 53_000, size: 250_000 },
        ...rest,
    }) as Run;
/** A run whose window is 100K tokens, `used` thousand of them taken. */
const filled = (used: number) => runOf({ context: { used: used * 1_000, size: 100_000 } });

const withoutCompact = (agentId: string): ModelStoreOptions => ({
    change: data => {
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
        expect(ring()!.getAttribute('aria-label')).toBe('Compact context, 21% full');
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
        await mount({
            chat: chatOn({ engine: 'cursor', model: 'default' }),
            run: runOf({ engine: 'cursor', context: undefined }),
        });

        expect(ring()).toBeNull();
        expect(modelPill()).not.toBeNull();
    });

    it('draws the percent as an arc and no arc for an empty window', async () => {
        const { update } = await mount({ chat: chatOn(), run: runOf() });

        expect(arc()!.getAttribute('stroke-dasharray')).toBe('21 79');

        await update({ run: runOf({ context: { used: 0, size: 250_000 } }) });

        expect(ring()!.getAttribute('aria-label')).toBe('Compact context, 0% full');
        expect(arc()).toBeNull();
    });

    it('stays for a chat whose orchestrator has finished: the last reading is kept', async () => {
        await mount({ chat: chatOn(), run: runOf({ status: 'failed' }) });

        expect(ring()).not.toBeNull();
    });
});

describe('its tooltip', () => {
    it('shows one bar, the percentage and the token counts on hover', async () => {
        await mount({ chat: chatOn(), run: runOf() });

        expect(tooltip()).toBeNull();
        await act(async () => {
            document.dispatchEvent(new PointerEvent('pointermove', pointer));
            ring()!.dispatchEvent(new PointerEvent('pointerover', pointer));
            await new Promise(resolve => setTimeout(resolve, 550));
        });
        await settle();

        expect(tooltip()!.textContent).toContain('21% full');
        expect(tooltip()!.textContent).toContain('~53K / 250K');
        expect(tooltip()!.querySelectorAll('[role="meter"]')).toHaveLength(1);
        expect(tooltip()!.querySelector('button')).toBeNull();
        expect(meter()?.getAttribute('aria-valuenow')).toBe('21');
        expect(meter()?.querySelector<HTMLElement>('div')?.style.width).toBe('21%');
        expect(sent).toEqual([]);
    });

    it('opens on keyboard focus and disappears on press', async () => {
        await mount({ chat: chatOn(), run: runOf() });
        await focusRing();

        expect(ring()!.getAttribute('aria-describedby')).toBe(tooltip()!.id);
        await press(ring());
        await settle();

        expect(tooltip()).toBeNull();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it.each([
        [79, 'normal'],
        [80, 'warning'],
        [89, 'warning'],
        [90, 'danger'],
        [100, 'danger'],
    ])('tones the ring and the bar at %i%% as %s', async (percent, tone) => {
        await mount({ chat: chatOn(), run: filled(percent) });
        await focusRing();

        expect(ring()!.querySelector('svg')!.getAttribute('data-tone')).toBe(tone);
        expect(meter()?.getAttribute('data-tone')).toBe(tone);
        expect(tooltip()!.textContent).toContain(`${percent}% full`);
    });

    it('keeps a window that is over full at 100%', async () => {
        await mount({ chat: chatOn(), run: runOf({ context: { used: 260_000, size: 200_000 } }) });
        await focusRing();

        expect(ring()!.getAttribute('aria-label')).toBe('Compact context, 100% full');
        expect(tooltip()!.textContent).toContain('~260K / 200K');
    });

    it('follows the run as its reading changes with the tooltip open', async () => {
        const { update } = await mount({ chat: chatOn(), run: runOf() });
        await focusRing();

        await update({ run: runOf({ context: { used: 200_000, size: 250_000 } }) });

        expect(ring()!.getAttribute('aria-label')).toBe('Compact context, 80% full');
        expect(tooltip()!.textContent).toContain('80% full');
        expect(tooltip()!.textContent).toContain('~200K / 250K');
        expect(meter()?.getAttribute('data-tone')).toBe('warning');

        await update({ run: runOf({ context: { used: 25_000, size: 250_000 } }) });

        expect(tooltip()!.textContent).toContain('10% full');
        expect(meter()?.getAttribute('data-tone')).toBe('normal');
    });

    it('goes away with the reading', async () => {
        const { update } = await mount({ chat: chatOn(), run: runOf() });

        await update({ run: runOf({ context: undefined }) });

        expect(ring()).toBeNull();
    });
});

describe('compaction from the ring', () => {
    it.each(['claude', 'codex'])('sends chat.compact directly for %s', async engine => {
        const chat = chatOn({ engine });
        await mount({ chat, run: runOf({ engine }) });
        await press(ring());

        expect(sent).toEqual([{ type: 'chat.compact', chatId: chat.id }]);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it.each([
        {
            chat: { engine: 'cursor', model: 'default' },
            run: { engine: 'cursor' },
            options: {},
        },
        { chat: {}, run: {}, options: withoutCompact('claude') },
        { chat: {}, run: {}, options: { agentsLoading: true } },
    ])('keeps an informational ring when compaction is unavailable', async entry => {
        await mount({ chat: chatOn(entry.chat), run: runOf(entry.run) }, entry.options);
        await focusRing();
        expect(ring()?.getAttribute('aria-disabled')).toBe('true');
        expect(ring()?.getAttribute('aria-label')).toBe('Context usage, 21% full');
        expect(meter()?.getAttribute('aria-valuenow')).toBe('21');

        await press(ring());

        expect(sent).toEqual([]);
    });

    it("asks the chat's own agent, and the run's for a chat from before chats had one", async () => {
        const chat = chatOn({ engine: undefined });
        await mount({ chat, run: runOf({ engine: 'codex' }) }, withoutCompact('claude'));
        await press(ring());

        expect(sent).toEqual([{ type: 'chat.compact', chatId: chat.id }]);
    });

    it('suppresses repeat presses while the command is pending', async () => {
        let answer!: (result: CommandResult) => void;
        const onItsWay = () =>
            new Promise<CommandResult>(resolve => {
                answer = resolve;
            });

        await mount({ chat: chatOn(), run: runOf(), answer: onItsWay });
        await press(ring());

        expect(sent).toHaveLength(1);
        expect(ring()!.hasAttribute('data-pending')).toBe(true);
        await press(ring());
        expect(sent).toHaveLength(1);

        await act(async () => answer(accepted));

        expect(ring()!.hasAttribute('data-pending')).toBe(false);
    });

    it("shows the daemon's refusal as the usual toast", async () => {
        await mount({ chat: chatOn(), run: runOf(), answer: () => refused });
        await press(ring());

        expect(toasts.error).toHaveBeenCalledWith({ message: refused.ok ? '' : refused.error.message });
    });

    it.each([...TERMINAL_RUN_STATUSES, ...ACTIVE_RUN_STATUSES])(
        'sends the same command when the run is %s',
        async status => {
            const chat = chatOn();
            await mount({ chat, run: runOf({ status }) });
            await press(ring());

            expect(sent).toEqual([{ type: 'chat.compact', chatId: chat.id }]);
        }
    );

    it('keeps the usage available and blocks duplicate compaction while one is already queued', async () => {
        const queued: QueuedMessage = {
            id: 'q-1',
            mode: 'queue',
            command: 'compact',
            text: 'Compact the conversation',
            content: '/compact',
            createdAt: 0,
        };
        await mount({ chat: chatOn({ queue: [queued] }), run: runOf({ status: 'running' }) });

        expect(ring()!.getAttribute('aria-disabled')).toBe('true');
        expect(ring()!.getAttribute('aria-label')).toBe('Compact context queued, 21% full');
        expect(arc()).not.toBeNull();
        await focusRing();
        expect(meter()?.getAttribute('aria-valuenow')).toBe('21');

        await press(ring());
        expect(sent).toEqual([]);
    });
});
