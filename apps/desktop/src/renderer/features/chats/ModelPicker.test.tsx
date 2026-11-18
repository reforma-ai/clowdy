// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelPicker, ModelPickerOff, type ModelPickerProps, type PickerProvider } from './ModelPicker';
import { readRemembered, writeRemembered, type ModelChoice } from './modelSelection';
import { modelStore, type ModelStoreOptions } from './modelTestKit';

import type { AgentModel, AgentModels } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
async function setup(choice: ModelChoice | undefined, options: ModelStoreOptions = {}, engines: string[] = ['claude', 'codex', 'cursor'], running = false) {
    store = await modelStore(options);

    const providers: PickerProvider[] = engines.map(id => ({ id, name: NAMES[id]!, list: store.models.of(id) }));

    props = { choice, providers, running, onPick: next => picks.push(next) };
    await draw();
}

const draw = () => act(async () => {
    root.render(<ModelPicker { ...props } />);
});

/** Lets a popover place itself and its transitions end. */
const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
});

const pointer = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, width: 1, height: 1, pressure: 0.5, detail: 1 };

/** A press as a mouse makes it. */
const press = (element: Element | null | undefined) => act(async () => {
    element!.dispatchEvent(new PointerEvent('pointerdown', pointer));
    element!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    element!.dispatchEvent(new PointerEvent('pointerup', pointer));
    element!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
});

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const selectModel = () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Select model"]')!;
const faceLayer = () => selectModel().parentElement!.parentElement!;
const listLayer = () => faceLayer().nextElementSibling as HTMLElement;
const slider = () => dialog()!.querySelector<HTMLElement>('[role="slider"]');
const options = () => [...listLayer().querySelectorAll<HTMLElement>('[role="option"]')];
const optionNamed = (name: string) => options().find(option => option.textContent === name)!;
const texts = (elements: Element[]) => elements.map(element => element.textContent);
const onList = () => !listLayer().hasAttribute('inert');
const onFace = () => !faceLayer().hasAttribute('inert');
const key = (target: Element, name: string) => act(async () => {
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

/** A model list of a provider, with the levels each model is given. */
const models = (...entries: [id: string, efforts?: string[], rest?: Partial<AgentModel>][]): AgentModels => ({
    state: 'ok',
    models: entries.map(([id, efforts, rest]) => ({ id, name: id.toUpperCase(), ...(efforts && { efforts }), ...rest })),
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
    it('shows the provider\'s mark, the model and its level muted, and names them for a screen reader', async () => {
        await setup(opus);

        // The provider's mark and the chevron.
        expect(trigger().querySelectorAll('svg')).toHaveLength(2);
        expect(trigger().textContent).toBe('Opus 5.5High');
        expect(trigger().getAttribute('aria-label')).toBe('Model: Opus 5.5 · High');
    });

    it('says the level in the words of the person, in the agent\'s own spelling', async () => {
        await setup({ engine: 'codex', model: 'gpt-6.2-sol', effort: 'xhigh' });

        expect(trigger().textContent).toBe('GPT-6.2 SolExtra high');
    });

    it('shows no level for a model that has none, and the model\'s own default for a level it does not offer', async () => {
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

    it('takes the pill\'s rectangle once for as long as it is open, and again at the next opening', async () => {
        await setup(opus);

        // What the popover itself asks of the pill is not what the popover's anchor is: count the asks that come from the picker.
        let taken = 0;

        vi.spyOn(trigger(), 'getBoundingClientRect').mockImplementation(() => {
            if (new Error().stack?.includes('ModelPicker.tsx')) taken += 1;

            return { left: 0, top: 500, width: 120, height: 30, right: 120, bottom: 530, x: 0, y: 500, toJSON: () => ({}) };
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

        vi.stubGlobal('ResizeObserver', class {
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
        });

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
            return this.querySelector('[role="listbox"]') ? heights.list! : this.querySelector('button[aria-label="Select model"]') ? heights.face! : 0;
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
    it('is in a section for each provider, in the order they are offered, each model with its provider\'s mark', async () => {
        await setup(opus);
        await openList();

        expect(texts([...listLayer().querySelectorAll('header')])).toEqual(['Claude Code', 'Codex', 'Cursor']);
        expect(texts(options())).toEqual([
            // The "Default (recommended)" row is Opus once, as the default.
            'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'Opus 4.6', 'Haiku 4.5',
            'GPT-6.2 Sol', 'GPT-6 Sol', 'GPT-6 Luna', 'GPT-6 Mini',
            // Cursor's own model named Auto is a row like any other.
            'Auto', 'Claude Opus 5.5', 'GPT-5.5', 'Grok 4.5', 'Composer 2.5',
        ]);
        expect(options().every(option => option.querySelector('svg') !== null)).toBe(true);
        expect(options().map(option => option.getAttribute('data-engine'))).toEqual(
            [...Array(6).fill('claude'), ...Array(4).fill('codex'), ...Array(5).fill('cursor')]
        );
        expect(listLayer().querySelector('[role="listbox"]')!.getAttribute('aria-label')).toBe('Model');
    });

    it('marks the model in force with a check, and only that one', async () => {
        await setup(opus);
        await openList();

        const selected = options().filter(option => option.getAttribute('aria-selected') === 'true');

        expect(texts(selected)).toEqual(['Opus 5.5']);
        // The mark and the check, against the mark alone.
        expect(selected[0]!.querySelectorAll('svg')).toHaveLength(2);
        expect(options().filter(option => option.getAttribute('aria-selected') !== 'true').every(option => option.querySelectorAll('svg').length === 1)).toBe(true);
    });

    it('marks the model of the right provider when two share an id', async () => {
        await setup({ engine: 'cursor', model: 'default', effort: undefined }, {
            change: (data) => {
                // Claude Code's own `default` row stands for Opus and is left out of the list; here it is a row of its own.
                const row = data.agentModels.claude!.models.find(model => model.id === 'default')!;

                row.isDefault = false;
                delete row.resolvedId;
            },
        });
        await openList();

        expect(texts(options().filter(option => option.getAttribute('data-model-id') === 'default'))).toEqual(['Default (recommended)', 'Auto']);
        expect(texts(options().filter(option => option.getAttribute('aria-selected') === 'true'))).toEqual(['Auto']);
    });

    it('has no section header when it offers one provider', async () => {
        await setup(opus, {}, ['claude']);
        await openList();

        expect(listLayer().querySelector('header')).toBeNull();
        expect(options()).toHaveLength(6);
        expect(options().every(option => option.getAttribute('data-engine') === 'claude')).toBe(true);
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
        await press(optionNamed('GPT-6 Sol'));

        expect(picks).toEqual([{ engine: 'codex', model: 'gpt-6-sol', effort: 'ultra' }]);
    });

    it('gives a model with no levels none', async () => {
        await setup(opus);
        await openList();
        await press(optionNamed('Haiku 4.5'));

        expect(picks).toEqual([{ engine: 'claude', model: 'claude-haiku-4-5-20251001' }]);
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
            document.activeElement!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
        });

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
                document.activeElement!.dispatchEvent(new KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true }));
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
        data.agentModels.claude = models(['six', levels], ['five', levels.slice(0, 5)], ['two', ['low', 'high']], ['one', ['max']], ['none', undefined, { description: 'Small and quick, with no reasoning control' }]);
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

    it('shows a model\'s only level as text, without a slider', async () => {
        await setup({ engine: 'claude', model: 'one', effort: 'max' }, { change: withLevels });
        await open();

        expect(slider()).toBeNull();
        expect(dialog()!.textContent).toContain('Reasoning effort');
        expect(faceLayer().textContent).toBe('ONEMaxReasoning effortMax');
        expect(trigger().textContent).toBe('ONEMax');
    });

    it('shows the description of a model with no levels instead of a slider', async () => {
        await setup({ engine: 'claude', model: 'none' }, { change: withLevels });
        await open();

        expect(slider()).toBeNull();
        expect(dialog()!.textContent).not.toContain('Reasoning effort');
        expect(faceLayer().textContent).toBe('NONESmall and quick, with no reasoning control');
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

        expect(listLayer().querySelectorAll('[role="status"]')).toHaveLength(3);
        expect(listLayer().textContent).toContain('Reading the models…');
        expect(options()).toEqual([]);

        await setup({ engine: 'claude' }, { read, preload: false });

        expect(trigger().textContent).toBe('Model');
    });

    it('shows the model by its name once its list has come', async () => {
        const arrive: (() => void)[] = [];
        const read = (_agentId: string, fixture: AgentModels) => new Promise<AgentModels>((resolve) => {
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

        const note = listLayer().querySelector<HTMLElement>('[data-provider="codex"]')!;

        expect(note.textContent).toContain('Codex');
        expect(note.textContent).toContain('The models could not be read. The daemon is away');
        expect(texts([...listLayer().querySelectorAll('header')])).toEqual(['Claude Code', 'Cursor']);

        fail = false;
        await press(note.querySelector('button'));
        await draw();

        expect(listLayer().querySelector('[data-provider="codex"]')).toBeNull();
        expect(options().filter(option => option.getAttribute('data-engine') === 'codex').length).toBeGreaterThan(0);
    });

    it('says what an agent that cannot list its models answers, with Retry', async () => {
        await setup(opus, {
            change: (data) => {
                data.agentModels.cursor = { state: 'unavailable', models: [], detail: 'Cursor is not signed in' };
            },
        });
        await openList();

        const note = listLayer().querySelector<HTMLElement>('[data-provider="cursor"]')!;

        expect(note.textContent).toContain('Cursor is not signed in');
        expect(note.querySelector('button')!.textContent).toBe('Retry');
        expect(options().some(option => option.getAttribute('data-engine') === 'cursor')).toBe(false);
    });

    it('shows a held model that is not in the list by its id, says so, and selects no row', async () => {
        await setup({ engine: 'claude', model: 'claude-sonnet-3-7', effort: 'high' });

        expect(trigger().textContent).toBe('claude-sonnet-3-7');

        await open();

        expect(selectModel().textContent).toBe('claude-sonnet-3-7');
        expect(slider()).toBeNull();
        expect(faceLayer().textContent).toContain('Claude Code does not list this model anymore.');

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

        const note = listLayer().querySelector<HTMLElement>('[data-provider="codex"]')!;

        expect(note.textContent).toContain('The daemon is away');
        expect(options().filter(option => option.getAttribute('data-engine') === 'codex')).toHaveLength(4);
    });

    it('holds the stored choice of a provider that is not offered, by its id', async () => {
        await setup({ engine: 'codex', model: 'gpt-6-sol', effort: 'high' }, {}, ['claude']);

        expect(trigger().textContent).toBe('gpt-6-sol');
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
