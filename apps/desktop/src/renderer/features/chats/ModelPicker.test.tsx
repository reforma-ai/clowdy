// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelPicker, ModelPickerOff, type ModelPickerProps, type PickerProvider } from './ModelPicker';
import { type ModelChoice, readRemembered, writeRemembered } from './modelSelection';
import { type ModelStoreOptions, modelStore } from './modelTestKit';

import type { AgentModel, AgentModels } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The app is used on a Mac, where React Aria leaves the action of Enter alone (it would block the context-menu shortcut). It reads the platform
// once, so this runs before it can.
vi.hoisted(() => {
    Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true });
});

/*
 * The model and reasoning picker on the fixture daemon's models. The test build has no MobX observer, so the picker is drawn again by
 * hand after a list changes, as the observer does in the app.
 */

const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const opus: ModelChoice = { engine: 'claude', model: 'opus', effort: 'high' };

let container: HTMLDivElement;
let root: Root;
let picks: ModelChoice[];
let store: Awaited<ReturnType<typeof modelStore>>;
let props: ModelPickerProps;

/** Builds the picker's providers from the models store; `engines` are the ones the list offers. */
async function setup(
    choice: ModelChoice | undefined,
    options: ModelStoreOptions = {},
    engines: string[] = ['claude', 'codex', 'cursor'],
    running = false
) {
    store = await modelStore(options);

    const providers: PickerProvider[] = engines.map(id => ({ id, name: NAMES[id]!, list: store.models.of(id) }));

    props = { choice, providers, running, onPick: next => picks.push(next) };
    await draw();
}

const draw = () =>
    act(async () => {
        root.render(<ModelPicker {...props} />);
    });

/** Lets what a popover does as it opens or closes run its course. Nothing in the test build waits on a timer, so no time needs to pass. */
const settle = () =>
    act(async () => {
        await Promise.resolve();
    });

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

/** A press as a mouse makes it. */
const press = (element: Element | null | undefined) =>
    act(async () => {
        element!.dispatchEvent(new PointerEvent('pointerdown', pointer));
        element!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        element!.dispatchEvent(new PointerEvent('pointerup', pointer));
        element!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    });

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Model and reasoning effort"]');
const selectModel = () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Select model"]')!;
const faceLayer = () => selectModel().parentElement!.parentElement!;
const listLayer = () => faceLayer().nextElementSibling as HTMLElement;
const slider = () => dialog()!.querySelector<HTMLElement>('[role="slider"]');
const options = () => [...listLayer().querySelectorAll<HTMLElement>('[role="option"]')];
const optionNamed = (name: string) => options().find(option => option.textContent === name)!;
const texts = (elements: Element[]) => elements.map(element => element.textContent);
const tabs = () => [...listLayer().querySelectorAll<HTMLElement>('[role="tab"]')];
const tabNamed = (name: string) => tabs().find(tab => tab.getAttribute('aria-label') === name)!;
const selectedTab = () =>
    tabs()
        .filter(tab => tab.getAttribute('aria-selected') === 'true')
        .map(tab => tab.getAttribute('aria-label'));
const flyout = () => document.querySelector<HTMLElement>('[data-model-flyout]');
const flyoutOptions = () => [...(flyout()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
const flyoutOptionNamed = (name: string) => flyoutOptions().find(option => option.textContent === name)!;
const onList = () => !listLayer().hasAttribute('inert');
const onFace = () => !faceLayer().hasAttribute('inert');
const key = (target: Element, name: string) =>
    act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });

async function open() {
    await press(trigger());
    await settle();
}

async function openList() {
    await open();
    await press(selectModel());
}

/** A key as a person presses it: down, then up. */
const tap = async (target: Element, name: string) => {
    await key(target, name);
    await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true }));
    });
};

/** Presses Enter on `target` and says whether the key's own action was left to run: that action is a click on whatever holds the focus once the pick has moved it. */
async function enterIsCancelled(target: Element) {
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    await act(async () => {
        target.dispatchEvent(enter);
    });

    return enter.defaultPrevented;
}

/** Opens the flyout of "More models" with a press, and lets it place itself. */
async function openFlyout() {
    await openList();
    await press(optionNamed('More models'));
    await settle();
}

/** A model list of a provider, with the levels each model is given. */
const models = (...entries: [id: string, efforts?: string[], rest?: Partial<AgentModel>][]): AgentModels => ({
    state: 'ok',
    models: entries.map(([id, efforts, rest]) => ({
        id,
        name: id.toUpperCase(),
        ...(efforts && { efforts }),
        ...rest,
    })),
});

beforeEach(() => {
    localStorage.clear();
    picks = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the pill', () => {
    it("shows the provider's mark, the model and its level muted, and names them for a screen reader", async () => {
        await setup(opus);

        // The provider's mark and the chevron.
        expect(trigger().querySelectorAll('svg')).toHaveLength(2);
        expect(trigger().textContent).toBe('Opus 5.5High');
        expect(trigger().getAttribute('aria-label')).toBe('Model: Opus 5.5, High');
    });

    it("says the level in the words of the person, in the agent's own spelling", async () => {
        await setup({ engine: 'codex', model: 'gpt-6.2-sol', effort: 'xhigh' });

        expect(trigger().textContent).toBe('GPT-6.2 SolExtra high');
    });

    it("shows no level for a model that has none, and the model's own default for a level it does not offer", async () => {
        await setup({ engine: 'claude', model: 'claude-haiku-4-5-20251001' });

        expect(trigger().textContent).toBe('Haiku 4.5');
        expect(trigger().getAttribute('aria-label')).toBe('Model: Haiku 4.5');

        await setup({ engine: 'codex', model: 'gpt-6.2-sol', effort: 'minimal' });

        expect(trigger().textContent).toBe('GPT-6.2 SolLow');
    });

    it('is nothing without a choice', async () => {
        await setup(undefined);

        expect(container.querySelector('button')).toBeNull();
    });

    it('is a disabled pill that says there is no provider when none is on', async () => {
        await act(async () => {
            root.render(<ModelPickerOff />);
        });

        expect(container.querySelector('button')!.disabled).toBe(true);
        expect(container.textContent).toBe('No provider');
    });
});

describe('the picker without providers', () => {
    it('keeps inheritance choices available and explains why the model list is empty', async () => {
        await setup({ engine: '' }, {}, []);
        const choices: string[] = [];
        props = {
            ...props,
            alternatives: {
                selected: 'default',
                options: [
                    { id: 'default', label: 'Use default' },
                    { id: 'inherit', label: 'Inherit orchestrator' },
                ],
                onPick: id => choices.push(id),
            },
        };
        await draw();
        expect(trigger().getAttribute('aria-label')).toBe('Model: Use default');
        await open();
        expect(dialog()?.textContent).toContain('No available provider');
        const inherit = [...dialog()!.querySelectorAll('button')].find(
            button => button.textContent === 'Inherit orchestrator'
        );
        await press(inherit);
        expect(choices).toEqual(['inherit']);
    });
});

describe('the popover', () => {
    it('opens on a press with the model button and the reasoning slider, and closes on Escape', async () => {
        await setup(opus);

        expect(dialog()).toBeNull();
        expect(trigger().getAttribute('aria-expanded')).toBe('false');

        await open();

        // A button that opens a popover is not a toggle: it says it is expanded, and not that it is pressed.
        expect(trigger().getAttribute('aria-expanded')).toBe('true');
        expect(trigger().hasAttribute('aria-pressed')).toBe(false);
        expect(trigger().hasAttribute('data-open')).toBe(true);
        expect(dialog()!.getAttribute('aria-label')).toBe('Model and reasoning effort');
        expect(selectModel().textContent).toBe('Opus 5.5High');
        expect(slider()!.getAttribute('aria-valuetext')).toBe('High');
        expect(slider()!.getAttribute('aria-valuenow')).toBe('2');
        expect(dialog()!.textContent).toContain('Reasoning effort');

        await key(selectModel(), 'Escape');
        await settle();

        expect(dialog()).toBeNull();
    });

    it('keeps both panes and lets only the one in view be reached', async () => {
        await setup(opus);
        await open();

        expect(onFace()).toBe(true);
        expect(onList()).toBe(false);
        expect(options().length).toBeGreaterThan(0);
        // The swap itself is CSS: these are what it reads.
        expect(faceLayer().hasAttribute('data-hidden')).toBe(false);
        expect(listLayer().hasAttribute('data-open')).toBe(false);

        await press(selectModel());

        expect(onFace()).toBe(false);
        expect(onList()).toBe(true);
        expect(faceLayer().hasAttribute('data-hidden')).toBe(true);
        expect(listLayer().hasAttribute('data-open')).toBe(true);

        await press(listLayer().querySelector('button[aria-label="Back"]'));

        expect(faceLayer().hasAttribute('data-hidden')).toBe(false);
        expect(listLayer().hasAttribute('data-open')).toBe(false);
    });

    it('starts on the face every time it opens', async () => {
        await setup(opus);
        await openList();
        await key(document.activeElement!, 'Escape');
        await key(selectModel(), 'Escape');
        await settle();
        await open();

        expect(onFace()).toBe(true);
        expect(onList()).toBe(false);
    });

    it('says a pick applies from the next message while the orchestrator works, and not otherwise', async () => {
        await setup(opus, {}, undefined, true);
        await open();

        expect(dialog()!.textContent).toContain('Applies from the next message');

        props = { ...props, running: false };
        await draw();

        expect(dialog()!.textContent).not.toContain('Applies from the next message');
    });

    it("takes the pill's rectangle once for as long as it is open, and again at the next opening", async () => {
        await setup(opus);

        // What the popover itself asks of the pill is not what the popover's anchor is: count the asks that come from the picker.
        let taken = 0;

        vi.spyOn(trigger(), 'getBoundingClientRect').mockImplementation(() => {
            if (new Error().stack?.includes('ModelPicker.tsx')) taken += 1;

            return {
                left: 0,
                top: 500,
                width: 120,
                height: 30,
                right: 120,
                bottom: 530,
                x: 0,
                y: 500,
                toJSON: () => ({}),
            };
        });

        await open();

        expect(taken).toBe(1);

        // The pill's label changes width as a model is chosen and the popover is placed again; it must not follow the pill.
        await act(async () => {
            window.dispatchEvent(new Event('resize'));
        });

        expect(taken).toBe(1);

        await key(selectModel(), 'Escape');
        await settle();
        await open();
        await act(async () => {
            window.dispatchEvent(new Event('resize'));
        });

        expect(taken).toBe(2);
    });

    it('does not size the stage while the pane has no height to measure', async () => {
        await setup(opus);
        await open();

        // The test build has no layout: every pane is 0 tall.
        const stage = faceLayer().parentElement!;

        expect(stage.hasAttribute('data-measured')).toBe(false);
        expect(stage.style.height).toBe('');
    });

    it('watches the pane in view only, and lets go of each when it is not, and when the popover goes', async () => {
        const watching = new Set<Element>();
        const seen: Element[] = [];

        vi.stubGlobal(
            'ResizeObserver',
            class {
                #targets = new Set<Element>();

                // The popover and the list's scroll chrome have their own observers: only the stage's panes are of interest here.
                observe(target: Element) {
                    if (!target.matches('[class*="layer"]')) return;

                    this.#targets.add(target);
                    watching.add(target);
                    seen.push(target);
                }

                disconnect() {
                    for (const target of this.#targets) watching.delete(target);

                    this.#targets.clear();
                }

                unobserve() {}
            }
        );

        await setup(opus);
        await open();

        const face = faceLayer();
        const list = listLayer();

        expect([...watching]).toEqual([face]);

        await press(selectModel());

        expect([...watching]).toEqual([list]);

        await press(list.querySelector('button[aria-label="Back"]'));

        expect([...watching]).toEqual([face]);

        await key(selectModel(), 'Escape');
        await settle();

        expect(dialog()).toBeNull();
        expect([...watching]).toEqual([]);
        expect(seen).toEqual([face, list, face]);
    });

    it('sizes the stage to the pane in view, and follows it to the list', async () => {
        const heights: Record<string, number> = { face: 130, list: 300 };

        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
            return this.querySelector('[role="listbox"]')
                ? heights.list!
                : this.querySelector('button[aria-label="Select model"]')
                  ? heights.face!
                  : 0;
        });

        await setup(opus);
        await open();

        const stage = faceLayer().parentElement!;

        expect(stage.style.height).toBe('130px');
        expect(stage.hasAttribute('data-measured')).toBe(true);
        // Only what changes after the first measure is animated.
        expect(stage.hasAttribute('data-animate')).toBe(true);

        await press(selectModel());

        expect(stage.style.height).toBe('300px');
    });
});

describe('the list', () => {
    it('shows the main models of the provider in force, each with its mark, and the row that opens the rest', async () => {
        await setup(opus);
        await openList();

        // The "Default (recommended)" row is Opus once, as the default, and the daemon marks Claude's four aliases as the main ones.
        expect(texts(options())).toEqual(['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'More models']);
        expect(
            options()
                .filter(option => option.hasAttribute('data-model-id'))
                .every(option => option.querySelector('svg') !== null)
        ).toBe(true);
        expect(options().map(option => option.getAttribute('data-engine'))).toEqual([...Array(4).fill('claude'), null]);
        expect(listLayer().querySelector('header')).toBeNull();
        expect(listLayer().querySelector('[role="listbox"]')!.getAttribute('aria-label')).toBe('Model');
    });

    it('marks the model in force with a check, and only that one', async () => {
        await setup(opus);
        await openList();

        const selected = options().filter(option => option.getAttribute('aria-selected') === 'true');

        expect(texts(selected)).toEqual(['Opus 5.5']);
        // The mark and the check, against the mark alone.
        expect(selected[0]!.querySelectorAll('svg')).toHaveLength(2);
        expect(
            options()
                .filter(option => option.getAttribute('aria-selected') !== 'true')
                .every(option => option.querySelectorAll('svg').length === 1)
        ).toBe(true);
    });

    it('marks the model of the right provider when two share an id', async () => {
        await setup(
            { engine: 'cursor', model: 'default', effort: undefined },
            {
                change: data => {
                    // Claude Code's own `default` row stands for Opus and is left out of the list; here it is a row of its own.
                    const row = data.agentModels.claude!.models.find(model => model.id === 'default')!;

                    row.isDefault = false;
                    delete row.resolvedId;
                },
            }
        );
        await openList();

        expect(texts(options().filter(option => option.getAttribute('data-model-id') === 'default'))).toEqual(['Auto']);
        expect(texts(options().filter(option => option.getAttribute('aria-selected') === 'true'))).toEqual(['Auto']);

        await press(tabNamed('Claude Code'));

        expect(texts(options().filter(option => option.getAttribute('data-model-id') === 'default'))).toEqual([
            'Default (recommended)',
        ]);
        expect(options().filter(option => option.getAttribute('aria-selected') === 'true')).toEqual([]);
    });

    it('has no strip when it offers one provider', async () => {
        await setup(opus, {}, ['claude']);
        await openList();

        expect(listLayer().querySelector('[role="tablist"]')).toBeNull();
        expect(texts(options())).toEqual(['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'More models']);
        expect(
            options()
                .filter(option => option.hasAttribute('data-engine'))
                .every(option => option.getAttribute('data-engine') === 'claude')
        ).toBe(true);
    });

    it('goes back to the face with Back, and writes nothing', async () => {
        await setup(opus);
        await openList();
        await press(listLayer().querySelector('button[aria-label="Back"]'));

        expect(onFace()).toBe(true);
        expect(picks).toEqual([]);
    });

    it('picks a row once, with the level it takes there, and returns to the face', async () => {
        await setup(opus);
        await openList();
        await press(optionNamed('Fable 5.2'));

        expect(picks).toEqual([{ engine: 'claude', model: 'fable', effort: 'high' }]);
        expect(onFace()).toBe(true);
        expect(onList()).toBe(false);
        // Still open: the person sees the result.
        expect(dialog()).not.toBeNull();
    });

    it('takes a model of another provider, and the level it was last used at there', async () => {
        writeRemembered({ models: {}, efforts: { 'codex/gpt-6-sol': 'ultra' } });
        await setup(opus);
        await openList();
        await press(tabNamed('Codex'));
        await press(optionNamed('GPT-6 Sol'));

        expect(picks).toEqual([{ engine: 'codex', model: 'gpt-6-sol', effort: 'ultra' }]);
    });

    it('gives a model with no levels none', async () => {
        await setup(opus);
        await openList();
        await press(tabNamed('Cursor'));
        await press(optionNamed('Composer 2.5'));

        expect(picks).toEqual([{ engine: 'cursor', model: 'composer-2.5' }]);
    });

    it('just goes back when the model in force is picked again', async () => {
        await setup(opus);
        await openList();
        await press(optionNamed('Opus 5.5'));

        expect(picks).toEqual([]);
        expect(onFace()).toBe(true);
    });

    it('picks with the keyboard: arrows to a row, Enter', async () => {
        await setup(opus);
        await openList();

        expect(document.activeElement).toBe(optionNamed('Opus 5.5'));

        await key(document.activeElement!, 'ArrowDown');
        await key(document.activeElement!, 'Enter');
        await act(async () => {
            document.activeElement!.dispatchEvent(
                new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true })
            );
        });

        expect(picks).toEqual([{ engine: 'claude', model: 'fable', effort: 'high' }]);
        expect(onFace()).toBe(true);
    });

    it('cancels what Enter would do on its own on a row, since the pick moves the focus to the model button and a Mac would click it', async () => {
        await setup(opus);
        await openList();

        expect(await enterIsCancelled(optionNamed('Fable 5.2'))).toBe(true);
        expect(picks).toEqual([{ engine: 'claude', model: 'fable', effort: 'high' }]);
        expect(onFace()).toBe(true);
    });

    it('goes back to the face on Enter or Space on the model in force, as a press on it does, and writes nothing', async () => {
        await setup(opus);
        await open();

        for (const name of ['Enter', ' ']) {
            await press(selectModel());

            expect(document.activeElement).toBe(optionNamed('Opus 5.5'));

            await key(document.activeElement!, name);
            await act(async () => {
                document.activeElement!.dispatchEvent(
                    new KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true })
                );
            });

            expect(onFace()).toBe(true);
            expect(dialog()).not.toBeNull();
        }

        expect(picks).toEqual([]);
    });

    it('goes back to the face on Escape, and only then closes the popover', async () => {
        await setup(opus);
        await openList();
        await key(document.activeElement!, 'Escape');

        expect(onFace()).toBe(true);
        expect(dialog()).not.toBeNull();
        expect(picks).toEqual([]);

        await key(document.activeElement!, 'Escape');
        await settle();

        expect(dialog()).toBeNull();
    });

    it('puts the focus on the model in force when the list opens, and on the model button when it closes', async () => {
        await setup(opus);
        await open();
        await press(selectModel());

        expect(document.activeElement).toBe(optionNamed('Opus 5.5'));

        await press(listLayer().querySelector('button[aria-label="Back"]'));

        expect(document.activeElement).toBe(selectModel());

        await press(selectModel());
        await press(optionNamed('Fable 5.2'));

        expect(document.activeElement).toBe(selectModel());
    });

    it('puts the focus on the list when the model in force is not in it', async () => {
        await setup({ engine: 'claude', model: 'retired-model', effort: 'high' });
        await openList();

        expect(listLayer().contains(document.activeElement)).toBe(true);
    });
});

describe('the reasoning levels', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

    /** Claude's models with every number of levels. */
    const withLevels = (data: { agentModels: Record<string, AgentModels> }) => {
        data.agentModels.claude = models(
            ['six', levels],
            ['five', levels.slice(0, 5)],
            ['two', ['low', 'high']],
            ['one', ['max']],
            ['none', undefined, { description: 'Small and quick, with no reasoning control' }]
        );
    };

    it.each([
        ['six', 6, 'xhigh'],
        ['five', 5, 'high'],
        ['two', 2, 'low'],
    ])('is a slider with a stop for each of the levels of a model with %s of them', async (model, count, level) => {
        await setup({ engine: 'claude', model, effort: level }, { change: withLevels });
        await open();

        expect(slider()!.getAttribute('aria-valuemax')).toBe(String(count - 1));
        expect(slider()!.querySelectorAll('[style*="--point-p"]')).toHaveLength(count);
    });

    it('moves a level with the keys of the slider, and keeps the model and the provider', async () => {
        await setup({ engine: 'claude', model: 'six', effort: 'high' }, { change: withLevels });
        await open();
        await key(slider()!, 'ArrowRight');
        await key(slider()!, 'End');
        await key(slider()!, 'Home');

        expect(picks).toEqual([
            { engine: 'claude', model: 'six', effort: 'xhigh' },
            { engine: 'claude', model: 'six', effort: 'ultra' },
            { engine: 'claude', model: 'six', effort: 'low' },
        ]);
    });

    it("shows a model's only level as text, without a slider", async () => {
        await setup({ engine: 'claude', model: 'one', effort: 'max' }, { change: withLevels });
        await open();

        expect(slider()).toBeNull();
        expect(dialog()!.textContent).toContain('Reasoning effort');
        expect(dialog()!.textContent).toContain('Reasoning effortMax');
        expect(trigger().textContent).toBe('ONEMax');
    });

    it('shows the description of a model with no levels instead of a slider', async () => {
        await setup({ engine: 'claude', model: 'none' }, { change: withLevels });
        await open();

        expect(slider()).toBeNull();
        expect(dialog()!.textContent).not.toContain('Reasoning effort');
        expect(dialog()!.textContent).toContain('Small and quick, with no reasoning control');
    });

    it('lists the levels of the model it is moved to, not of the one it left', async () => {
        await setup({ engine: 'claude', model: 'six', effort: 'high' }, { change: withLevels });
        await open();

        expect(slider()!.getAttribute('aria-valuemax')).toBe('5');

        props = { ...props, choice: { engine: 'claude', model: 'two', effort: 'high' } };
        await draw();

        expect(slider()!.getAttribute('aria-valuemax')).toBe('1');
        expect(slider()!.getAttribute('aria-valuetext')).toBe('High');
    });
});

describe('when the models are not there', () => {
    it('shows the model by its id, or "Model", with a small spinner while the list is read, and the list area spins too', async () => {
        const read = vi.fn(() => new Promise<AgentModels>(() => undefined));

        await setup(opus, { read, preload: false });

        expect(trigger().textContent).toBe('opus');
        expect(trigger().querySelector('[role="status"]')).not.toBeNull();

        // The popover is what asks for the lists of the providers it offers.
        await open();

        expect(read).toHaveBeenCalledTimes(3);
        expect(trigger().querySelector('[role="status"]')).not.toBeNull();

        await press(selectModel());

        // The strip is there, and the provider it shows is the one being read.
        expect(tabs()).toHaveLength(3);
        expect(listLayer().querySelectorAll('[role="status"]')).toHaveLength(1);
        expect(listLayer().textContent).toContain('Reading the models…');
        expect(options()).toEqual([]);

        await setup({ engine: 'claude' }, { read, preload: false });

        expect(trigger().textContent).toBe('Model');
    });

    it('shows the model by its name once its list has come', async () => {
        const arrive: (() => void)[] = [];
        const read = (_agentId: string, fixture: AgentModels) =>
            new Promise<AgentModels>(resolve => {
                arrive.push(() => resolve(fixture));
            });

        await setup(opus, { read, preload: false });
        await open();

        expect(trigger().textContent).toBe('opus');

        await act(async () => arrive.forEach(resolve => resolve()));
        await draw();

        expect(trigger().textContent).toBe('Opus 5.5High');
        expect(trigger().querySelector('[role="status"]')).toBeNull();
    });

    it('says why a list failed, with Retry, and asks again on it', async () => {
        let fail = true;
        const read = vi.fn(async (agentId: string, fixture: AgentModels) => {
            if (fail && agentId === 'codex') throw new Error('The daemon is away');

            return fixture;
        });

        await setup(opus, { read });
        await openList();

        // The provider in force has its models; the one that failed says so when the strip turns to it, and only then.
        expect(listLayer().querySelector('.note, [class*="note"]')).toBeNull();
        expect(options().length).toBeGreaterThan(0);

        await press(tabNamed('Codex'));

        const note = listLayer().querySelector<HTMLElement>('[data-provider="codex"]')!;

        expect(note.textContent).toContain('The models could not be read. The daemon is away');
        expect(options()).toEqual([]);

        fail = false;
        await press(note.querySelector('button'));
        await draw();

        expect(listLayer().querySelector('[class*="note"]')).toBeNull();
        expect(options().filter(option => option.getAttribute('data-engine') === 'codex').length).toBeGreaterThan(0);
    });

    it('says what an agent that cannot list its models answers, with Retry', async () => {
        await setup(opus, {
            change: data => {
                data.agentModels.cursor = { state: 'unavailable', models: [], detail: 'Cursor is not signed in' };
            },
        });
        await openList();
        await press(tabNamed('Cursor'));

        const note = listLayer().querySelector<HTMLElement>('[data-provider="cursor"]')!;

        expect(note.textContent).toContain('Cursor is not signed in');
        expect(note.querySelector('button')!.textContent).toBe('Retry');
        expect(options()).toEqual([]);
    });

    it('reads a list again each time it opens while the last read gave no models, and reads nothing else', async () => {
        let signedIn = false;
        const read = vi.fn(
            async (agentId: string, fixture: AgentModels): Promise<AgentModels> =>
                agentId === 'cursor' && !signedIn
                    ? { state: 'error', models: [], detail: 'Cursor is not signed in' }
                    : fixture
        );

        await setup(opus, { read });
        read.mockClear();

        await open();
        await settle();

        // The lists that have models are left alone, and an open picker reads the other one once, not in a loop.
        expect(read.mock.calls.map(call => call[0])).toEqual(['cursor']);

        await key(selectModel(), 'Escape');
        signedIn = true;
        await open();
        await draw();
        await press(selectModel());
        await press(tabNamed('Cursor'));

        expect(read.mock.calls.map(call => call[0])).toEqual(['cursor', 'cursor']);
        expect(store.models.of('cursor').models?.state).toBe('ok');
        expect(options().filter(option => option.getAttribute('data-engine') === 'cursor').length).toBeGreaterThan(0);
    });

    it('shows a held model that is not in the list by its id, says so, and selects no row', async () => {
        await setup({ engine: 'claude', model: 'claude-sonnet-3-7', effort: 'high' });

        expect(trigger().textContent).toBe('claude-sonnet-3-7');

        await open();

        expect(selectModel().textContent).toBe('claude-sonnet-3-7');
        expect(slider()).toBeNull();
        expect(dialog()!.textContent).toContain('Claude Code does not list this model anymore.');

        await press(selectModel());

        expect(options().filter(option => option.getAttribute('aria-selected') === 'true')).toEqual([]);

        await press(optionNamed('Sonnet 5.5'));

        expect(picks).toEqual([{ engine: 'claude', model: 'sonnet', effort: 'high' }]);
    });

    it('names the provider when it is held with no model, once its list has been read', async () => {
        await setup({ engine: 'claude' });

        expect(trigger().textContent).toBe('Claude Code');
        expect(trigger().querySelector('[role="status"]')).toBeNull();
    });

    it('keeps the models it has read while a newer read failed, and says so', async () => {
        let fail = false;
        const read = async (agentId: string, fixture: AgentModels) => {
            if (fail && agentId === 'codex') throw new Error('The daemon is away');

            return fixture;
        };

        await setup(opus, { read });
        fail = true;
        await act(async () => store.models.of('codex').reload());
        await draw();
        await openList();
        await press(tabNamed('Codex'));

        const note = listLayer().querySelector<HTMLElement>('[data-provider="codex"]')!;

        expect(note.textContent).toContain('The daemon is away');
        expect(options().filter(option => option.getAttribute('data-engine') === 'codex')).toHaveLength(5);
    });

    it('holds the stored choice of a provider that is not offered, by its id', async () => {
        await setup({ engine: 'codex', model: 'gpt-6-sol', effort: 'high' }, {}, ['claude']);

        expect(trigger().textContent).toBe('gpt-6-sol');
    });
});

describe('the pill in a narrow card', () => {
    // The level is dropped by a container query on the composer card (jsdom-style tests do not lay anything out), so the rule is read from the source.
    it('drops the level below 380px, because the context ring takes about 34px of the same row as the pill', () => {
        const pickerCss = readFileSync(join(import.meta.dirname, 'ModelPicker.module.css'), 'utf8');
        const widths = [...pickerCss.matchAll(/@container \(max-width: (\d+)px\)/g)].map(match => Number(match[1]));

        expect(widths).toEqual([380]);
    });
});

describe('the remembered choice', () => {
    it('is read at a pick, so a model picked a moment ago gives its level back', async () => {
        await setup(opus);
        await openList();
        writeRemembered({ ...readRemembered(), efforts: { 'claude/fable': 'max' } });
        await press(optionNamed('Fable 5.2'));

        expect(picks).toEqual([{ engine: 'claude', model: 'fable', effort: 'max' }]);
    });
});

describe('a chat with no model', () => {
    const bare = { engine: 'claude' } satisfies ModelChoice;
    const sentence = "Runs on Claude Code's own default until you pick a model.";

    it('reads "Default model" on the face, with the provider\'s mark and a muted line, and the provider on the pill', async () => {
        await setup(bare, {}, ['claude']);

        expect(trigger().textContent).toBe('Claude Code');

        await open();

        expect(selectModel().textContent).toBe('Default model');
        expect(selectModel().querySelectorAll('svg')).toHaveLength(2);
        expect(dialog()!.textContent).toContain(sentence);
        expect(slider()).toBeNull();
        expect(dialog()!.textContent).not.toContain('Reasoning effort');
    });

    it('names the provider the list was given', async () => {
        await setup({ engine: 'codex' }, {}, ['codex']);
        await open();

        expect(dialog()!.textContent).toContain("Runs on Codex's own default until you pick a model.");
    });

    it('checks no row of the list', async () => {
        await setup(bare, {}, ['claude']);
        await openList();

        expect(options().length).toBeGreaterThan(0);
        expect(options().filter(option => option.getAttribute('aria-selected') === 'true')).toEqual([]);
        expect(listLayer().contains(document.activeElement)).toBe(true);
    });

    it('does not say it while the models are still being read', async () => {
        await setup(bare, { read: () => new Promise<AgentModels>(() => undefined), preload: false }, ['claude']);
        await open();

        expect(selectModel().textContent).toBe('Model');
        expect(faceLayer().textContent).not.toContain('own default');
    });

    it('is picked out of by a pick like any other model', async () => {
        await setup(bare, {}, ['claude']);
        await openList();
        await press(optionNamed('Fable 5.2'));

        expect(picks).toEqual([{ engine: 'claude', model: 'fable', effort: 'high' }]);
    });
});

describe("the face's spacing", () => {
    /** The block under the model button: the slider, the description, the line of a chat with no model. */
    const reasoning = () => dialog()!.querySelector('[class*="reasoning"]');

    it('reserves no block under the model button when there is nothing to put in it', async () => {
        // A model with no levels and no description: the face is the button alone.
        await setup(
            { engine: 'claude', model: 'bare' },
            {
                change: data => {
                    data.agentModels.claude = models(['bare']);
                },
            }
        );
        await open();

        expect(faceLayer().textContent).toBe('BARE');
        expect(reasoning()).toBeNull();
        expect([...faceLayer().firstElementChild!.children]).toHaveLength(1);
    });

    it('has the block for a slider', async () => {
        await setup(opus);
        await open();

        expect(reasoning()).not.toBeNull();
    });

    it('has the block for a description', async () => {
        await setup(
            { engine: 'claude', model: 'described' },
            {
                change: data => {
                    data.agentModels.claude = models(['described', undefined, { description: 'Quick' }]);
                },
            }
        );
        await open();

        expect(reasoning()!.textContent).toBe('Quick');
    });

    it('has the block for the line of a chat with no model', async () => {
        await setup({ engine: 'claude' }, {}, ['claude']);
        await open();

        expect(reasoning()!.textContent).toBe("Runs on Claude Code's own default until you pick a model.");
    });

    it('has the block for the word that a pick applies later, and for that alone', async () => {
        await setup(
            { engine: 'claude', model: 'bare' },
            {
                change: data => {
                    data.agentModels.claude = models(['bare']);
                },
            },
            ['claude'],
            true
        );
        await open();

        expect(reasoning()!.textContent).toBe('Applies from the next message');
    });
});

describe('the provider strip', () => {
    it("is a tablist of the providers' marks with their names, the one in force selected", async () => {
        await setup({ engine: 'codex', model: 'gpt-6-sol', effort: 'high' });
        await openList();

        expect(listLayer().querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('Provider');
        expect(tabs().map(tab => tab.getAttribute('aria-label'))).toEqual(['Claude Code', 'Codex', 'Cursor']);
        expect(tabs().every(tab => tab.querySelector('svg') !== null && tab.textContent === '')).toBe(true);
        expect(selectedTab()).toEqual(['Codex']);
        expect(tabs().map(tab => tab.tabIndex)).toEqual([-1, 0, -1]);
        expect(
            options()
                .filter(option => option.hasAttribute('data-engine'))
                .every(option => option.getAttribute('data-engine') === 'codex')
        ).toBe(true);
    });

    it('sits at the end of the head row, after the title, above the list', async () => {
        await setup(opus);
        await openList();

        const strip = listLayer().querySelector('[role="tablist"]')!;

        expect(strip.previousElementSibling!.textContent).toBe('Select model');
        expect(strip.nextElementSibling).toBeNull();
        expect(strip.parentElement!.nextElementSibling!.contains(options()[0]!)).toBe(true);
    });

    it('turns the list to another provider and picks nothing', async () => {
        await setup(opus);
        await openList();
        await press(tabNamed('Cursor'));

        expect(selectedTab()).toEqual(['Cursor']);
        expect(texts(options())).toEqual([
            'Auto',
            'Grok 4.7',
            'Grok 4.6',
            'Composer 2.5',
            'Claude Opus 5.5',
            'More models',
        ]);
        expect(options().filter(option => option.getAttribute('aria-selected') === 'true')).toEqual([]);
        expect(picks).toEqual([]);
        expect(onList()).toBe(true);
        // The pill and the face still say what is held.
        expect(trigger().getAttribute('aria-label')).toBe('Model: Opus 5.5, High');

        await press(tabNamed('Claude Code'));

        expect(texts(options().filter(option => option.getAttribute('aria-selected') === 'true'))).toEqual([
            'Opus 5.5',
        ]);
    });

    it('moves between the tabs with the arrows, Home and End, and wraps', async () => {
        await setup(opus);
        await openList();
        tabNamed('Claude Code').focus();

        await key(document.activeElement!, 'ArrowRight');

        expect(selectedTab()).toEqual(['Codex']);
        expect(document.activeElement).toBe(tabNamed('Codex'));

        await key(document.activeElement!, 'ArrowRight');
        await key(document.activeElement!, 'ArrowRight');

        expect(selectedTab()).toEqual(['Claude Code']);

        await key(document.activeElement!, 'ArrowLeft');

        expect(selectedTab()).toEqual(['Cursor']);
        expect(options().some(option => option.getAttribute('data-model-id') === 'composer-2.5')).toBe(true);

        await key(document.activeElement!, 'Home');

        expect(selectedTab()).toEqual(['Claude Code']);

        await key(document.activeElement!, 'End');

        expect(selectedTab()).toEqual(['Cursor']);
        expect(picks).toEqual([]);
        // The strip keeps the keys it uses: the list pane has not gone back to the face.
        expect(onList()).toBe(true);
    });

    it('has the list of the provider it turned to take the focus on its first row, as when it was opened', async () => {
        await setup(opus);
        await openList();
        await press(tabNamed('Codex'));

        // Where Tab goes from the strip: the one stop of the list.
        listLayer().querySelector<HTMLElement>('[role="listbox"], [role="option"][tabindex="0"]')!.focus();

        expect(document.activeElement).toBe(optionNamed('GPT-6.2 Sol'));
    });

    it('starts on the provider in force every time the list opens', async () => {
        await setup(opus);
        await openList();
        await press(tabNamed('Codex'));
        await press(listLayer().querySelector('button[aria-label="Back"]'));
        await press(selectModel());

        expect(selectedTab()).toEqual(['Claude Code']);
    });

    it('follows the model in force to another provider', async () => {
        await setup(opus);
        await openList();
        await press(tabNamed('Codex'));
        await press(optionNamed('GPT-6 Sol'));

        props = { ...props, choice: picks[0]! };
        await draw();
        await press(selectModel());

        expect(selectedTab()).toEqual(['Codex']);
        expect(texts(options().filter(option => option.getAttribute('aria-selected') === 'true'))).toEqual([
            'GPT-6 Sol',
        ]);
    });

    it("is not there for one provider, and the list shows the held model's provider when the held one is not offered", async () => {
        await setup(opus, {}, ['codex', 'cursor']);
        await openList();

        // Claude is not offered: the strip starts on the first that is.
        expect(selectedTab()).toEqual(['Codex']);
        expect(tabs()).toHaveLength(2);
    });

    it("shows the provider's name as a tooltip when a tab is reached with the keyboard", async () => {
        await setup(opus);
        await openList();
        tabNamed('Claude Code').focus();
        await key(document.activeElement!, 'ArrowRight');
        await settle();

        expect(document.querySelector('[role="tooltip"]')!.textContent).toBe('Codex');
    });
});

describe('the main models', () => {
    it("are the first five in the agent's own order when it marks none as featured", async () => {
        await setup({ engine: 'cursor', model: 'default' });
        await openList();

        expect(texts(options())).toEqual([
            'Auto',
            'Grok 4.7',
            'Grok 4.6',
            'Composer 2.5',
            'Claude Opus 5.5',
            'More models',
        ]);

        await press(tabNamed('Codex'));

        expect(texts(options())).toEqual([
            'GPT-6.2 Sol',
            'GPT-6 Sol',
            'GPT-6 Luna',
            'GPT-6 Mini',
            'GPT-6 Codex',
            'More models',
        ]);
    });

    it('are the featured rows when the agent marks some, however many', async () => {
        await setup(
            { engine: 'claude', model: 'sonnet', effort: 'high' },
            {
                change: data => {
                    for (const model of data.agentModels.claude!.models)
                        model.featured = ['claude-opus-4-6', 'fable'].includes(model.id) || undefined;
                },
            }
        );
        await openList();

        // Two featured rows, and the model in force (Sonnet, which is not one of them) after them.
        expect(texts(options())).toEqual(['Fable 5.2', 'Opus 4.6', 'Sonnet 5.5', 'More models']);

        await press(optionNamed('More models'));
        await settle();

        expect(texts(flyoutOptions())).toEqual(['Opus 5.5', 'Haiku 5.5', 'Haiku 4.5']);
    });

    it('show the model in force as an extra row after them when it is not one of them, and the rest are behind "More models"', async () => {
        await setup({ engine: 'cursor', model: 'gpt-5.5', effort: 'medium' });
        await openList();

        expect(texts(options())).toEqual([
            'Auto',
            'Grok 4.7',
            'Grok 4.6',
            'Composer 2.5',
            'Claude Opus 5.5',
            'GPT-5.5',
            'More models',
        ]);
        expect(texts(options().filter(option => option.getAttribute('aria-selected') === 'true'))).toEqual(['GPT-5.5']);

        await press(optionNamed('More models'));
        await settle();

        expect(texts(flyoutOptions())).toEqual([
            'Claude Opus 5',
            'Claude Opus 4.8',
            'Gemini 4 Carbon',
            'Muse Wonder 1.0',
        ]);
    });

    it('show a model in force that the agent has not featured after the featured rows', async () => {
        await setup({ engine: 'claude', model: 'claude-opus-4-6', effort: 'high' });
        await openList();

        expect(texts(options())).toEqual([
            'Opus 5.5',
            'Fable 5.2',
            'Sonnet 5.5',
            'Haiku 5.5',
            'Opus 4.6',
            'More models',
        ]);

        await press(optionNamed('More models'));
        await settle();

        expect(texts(flyoutOptions())).toEqual(['Haiku 4.5']);
    });

    it('have no "More models" row when there is no more', async () => {
        await setup(
            { engine: 'claude', model: 'a' },
            {
                change: data => {
                    data.agentModels.claude = models(['a'], ['b'], ['c']);
                },
            }
        );
        await openList();

        expect(texts(options())).toEqual(['A', 'B', 'C']);
        expect(flyout()).toBeNull();
    });

    it('show a model held as the twin of another row as that row, checked', async () => {
        // Claude Code's hidden `default` row is Opus, which the list shows once.
        await setup({ engine: 'claude', model: 'default', effort: 'high' });

        expect(trigger().textContent).toBe('Opus 5.5High');

        await openList();

        expect(texts(options().filter(option => option.getAttribute('aria-selected') === 'true'))).toEqual([
            'Opus 5.5',
        ]);
        expect(texts(options())).not.toContain('Default (recommended)');

        // The model in force is not a new pick.
        await press(optionNamed('Opus 5.5'));

        expect(picks).toEqual([]);
    });
});

describe('the flyout of "More models"', () => {
    const moreRow = () => optionNamed('More models');

    it('has no mark on its row, a chevron at its end, and stays closed until it is asked for', async () => {
        await setup(opus);
        await openList();

        expect(flyout()).toBeNull();
        expect(moreRow().querySelector('svg')).not.toBeNull();
        expect(moreRow().hasAttribute('data-model-id')).toBe(false);
        expect(moreRow().getAttribute('aria-selected')).not.toBe('true');
    });

    it("opens on a press with the rest of the provider's models, as rows with a mark", async () => {
        await setup(opus);
        await openFlyout();

        expect(flyout()).not.toBeNull();
        expect(flyout()!.getAttribute('aria-label')).toBe('More models');
        expect(texts(flyoutOptions())).toEqual(['Opus 4.6', 'Haiku 4.5']);
        expect(
            flyoutOptions().every(
                option => option.querySelector('svg') !== null && option.getAttribute('data-engine') === 'claude'
            )
        ).toBe(true);
        expect(flyout()!.querySelector('[role="listbox"]')!.getAttribute('aria-label')).toBe('More models');
        // The flyout is a popover of its own, outside the picker's, and the picker stays where it is.
        expect(dialog()!.contains(flyout())).toBe(false);
        expect(onList()).toBe(true);
        expect(picks).toEqual([]);
    });

    it('takes the focus into its list', async () => {
        await setup(opus);
        await openFlyout();

        expect(document.activeElement).toBe(flyoutOptionNamed('Opus 4.6'));
    });

    it.each([
        ['Enter', 'Enter'],
        ['Space', ' '],
        ['ArrowRight', 'ArrowRight'],
    ])('opens on %s on the row', async (_name, name) => {
        await setup(opus);
        await openList();
        moreRow().focus();
        await tap(moreRow(), name);
        await settle();

        expect(flyout()).not.toBeNull();
        expect(texts(flyoutOptions())).toEqual(['Opus 4.6', 'Haiku 4.5']);
        expect(onList()).toBe(true);
        expect(picks).toEqual([]);
    });

    it('does not open on ArrowRight on a model', async () => {
        await setup(opus);
        await openList();
        await tap(optionNamed('Fable 5.2'), 'ArrowRight');
        await settle();

        expect(flyout()).toBeNull();
    });

    it.each([['Escape'], ['ArrowLeft']])(
        'closes on %s, with the focus back on the row, and the picker stays where it was',
        async name => {
            await setup(opus);
            await openFlyout();
            await key(document.activeElement!, name);
            await settle();

            expect(flyout()).toBeNull();
            expect(document.activeElement).toBe(moreRow());
            // Escape closes only the layer on top: the list is still there, and so is the popover.
            expect(onList()).toBe(true);
            expect(dialog()).not.toBeNull();
            expect(picks).toEqual([]);

            // And the next Escape goes back to the face, as ever.
            await key(document.activeElement!, 'Escape');

            expect(onFace()).toBe(true);
        }
    );

    it('opens again after it closed', async () => {
        await setup(opus);
        await openFlyout();
        await key(document.activeElement!, 'Escape');
        await settle();
        await tap(moreRow(), 'ArrowRight');
        await settle();

        expect(flyout()).not.toBeNull();
    });

    it('picks like the list does: with the level the model takes, back to the face, the picker open and the flyout gone', async () => {
        await setup(opus);
        await openFlyout();
        await press(flyoutOptionNamed('Opus 4.6'));
        await settle();

        expect(picks).toEqual([{ engine: 'claude', model: 'claude-opus-4-6', effort: 'high' }]);
        expect(onFace()).toBe(true);
        expect(dialog()).not.toBeNull();
        expect(flyout()).toBeNull();
        expect(document.activeElement).toBe(selectModel());
    });

    it('gives a model with no levels none', async () => {
        await setup(opus);
        await openFlyout();
        await press(flyoutOptionNamed('Haiku 4.5'));

        expect(picks).toEqual([{ engine: 'claude', model: 'claude-haiku-4-5-20251001' }]);
    });

    it('picks with the keyboard: arrows to a row, Enter', async () => {
        await setup(opus);
        await openFlyout();

        expect(document.activeElement).toBe(flyoutOptionNamed('Opus 4.6'));

        await key(document.activeElement!, 'ArrowDown');
        await tap(document.activeElement!, 'Enter');

        expect(picks).toEqual([{ engine: 'claude', model: 'claude-haiku-4-5-20251001' }]);
        expect(onFace()).toBe(true);
    });

    it('cancels what Enter would do on its own on a row of the flyout too', async () => {
        await setup(opus);
        await openFlyout();

        expect(await enterIsCancelled(flyoutOptionNamed('Opus 4.6'))).toBe(true);
        expect(picks).toEqual([{ engine: 'claude', model: 'claude-opus-4-6', effort: 'high' }]);
        expect(onFace()).toBe(true);
    });

    it('lists the rest of the provider the strip shows, and the level a model was last used at', async () => {
        writeRemembered({ models: {}, efforts: { 'codex/gpt-5.5': 'xhigh' } });
        await setup(opus);
        await openList();
        await press(tabNamed('Codex'));
        await press(moreRow());
        await settle();

        expect(texts(flyoutOptions())).toEqual(['GPT-5.5', 'GPT-5.5 Mini', 'GPT-5.4']);

        await press(flyoutOptionNamed('GPT-5.5'));

        expect(picks).toEqual([{ engine: 'codex', model: 'gpt-5.5', effort: 'xhigh' }]);
    });

    it('does not close the picker for a press that lands in it, on a row or on its plate', async () => {
        await setup(opus);
        await openFlyout();

        const plate = flyout()!;

        await act(async () => {
            plate.dispatchEvent(new PointerEvent('pointerdown', pointer));
            plate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            plate.dispatchEvent(new PointerEvent('pointerup', pointer));
            plate.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            plate.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        });
        await settle();

        expect(dialog()).not.toBeNull();
        expect(onList()).toBe(true);
        expect(flyout()).not.toBeNull();

        await press(flyoutOptionNamed('Opus 4.6'));
        await settle();

        expect(dialog()).not.toBeNull();
        expect(picks).toHaveLength(1);
    });

    it('closes, and not the picker, on a press that lands in the picker outside it', async () => {
        await setup(opus);
        await openFlyout();
        await press(listLayer().querySelector('[class*="listTitle"]'));
        await settle();

        expect(flyout()).toBeNull();
        expect(dialog()).not.toBeNull();
        expect(onList()).toBe(true);
        expect(picks).toEqual([]);
    });

    it("does not change the height of the picker, which is the list's: the flyout is outside it", async () => {
        const heights: Record<string, number> = { face: 130, list: 300 };

        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
            return this.matches('[class*="layer"]')
                ? this.querySelector('[role="listbox"]')
                    ? heights.list!
                    : heights.face!
                : 0;
        });

        await setup(opus);
        await openList();

        const stage = faceLayer().parentElement!;

        expect(stage.style.height).toBe('300px');

        await press(moreRow());
        await settle();

        expect(flyout()).not.toBeNull();
        expect(stage.style.height).toBe('300px');
        expect(stage.contains(flyout())).toBe(false);
    });

    it('is let go when the list goes back to the face, and does not come back with the list', async () => {
        await setup(opus);
        await openFlyout();
        await press(listLayer().querySelector('button[aria-label="Back"]'));
        await settle();

        expect(flyout()).toBeNull();

        await press(selectModel());

        // It does not come back with the list.
        expect(flyout()).toBeNull();
    });

    it("turns to another provider's rest when the strip does, and has none for a provider with no more", async () => {
        await setup(opus, {
            change: data => {
                data.agentModels.cursor = models(['a'], ['b']);
            },
        });
        await openFlyout();
        await key(document.activeElement!, 'Escape');
        await settle();
        await press(tabNamed('Cursor'));

        expect(texts(options())).toEqual(['A', 'B']);
        expect(flyout()).toBeNull();
    });
});

describe('a press on a row', () => {
    const up = (element: Element, button: number) =>
        act(async () => {
            element.dispatchEvent(new PointerEvent('pointerup', { ...pointer, button }));
        });

    it('picks the model as the pointer lets go with the primary button', async () => {
        await setup(opus);
        await openList();
        await up(optionNamed('Fable 5.2'), 0);

        expect(picks).toEqual([{ engine: 'claude', model: 'fable', effort: 'high' }]);
    });

    it("is not a pick with any other button: a secondary press is the system's", async () => {
        await setup(opus);
        await openList();
        await up(optionNamed('Fable 5.2'), 2);
        await up(optionNamed('Fable 5.2'), 1);

        expect(picks).toEqual([]);
        expect(onList()).toBe(true);
    });

    it('does not open the flyout with another button either', async () => {
        await setup(opus);
        await openList();
        await up(optionNamed('More models'), 2);
        await settle();

        expect(flyout()).toBeNull();

        await up(optionNamed('More models'), 0);
        await settle();

        expect(flyout()).not.toBeNull();
    });
});
