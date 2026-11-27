// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { DelegationPage } from './DelegationPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let store: RootStore;
let transport: FixtureTransport;

beforeEach(async () => {
    transport = new FixtureTransport();
    await transport.command({
        type: 'settings.setDelegation',
        requestId: 'request-initial',
        settings: {
            research: { kind: 'model', engine: 'retired-provider', model: 'old-model' },
        },
    });
    store = new RootStore(transport, { storage: undefined });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
        root.render(
            <RootStoreProvider value={store}>
                <DelegationPage />
            </RootStoreProvider>
        )
    );
    await vi.waitFor(() => expect(store.agentsStatus).toBe('ready'));
    await vi.waitFor(() => expect(container.querySelector('[aria-label^="Research selection:"]')).not.toBeNull());
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
});

const press = async (element: Element) =>
    act(async () => {
        element.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        element.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    });

describe('delegation settings', () => {
    it('opens the list directly, persists a model and effort, then inherits', async () => {
        const trigger = container.querySelector('[aria-label^="Code selection:"]')!;
        await press(trigger);
        const dialog = document.querySelector('[role="dialog"][aria-label="Model and reasoning effort"]')!;
        const list = dialog.querySelector<HTMLElement>('[class*="listLayer"]')!;
        expect(list.hasAttribute('inert')).toBe(false);
        expect(dialog.querySelector('[role="slider"]')).toBeNull();
        const first = list.querySelector<HTMLElement>('[role="option"]')!;
        const model = first.dataset.modelId;
        const engine = first.dataset.engine;
        await press(first);
        await vi.waitFor(async () =>
            expect((await transport.getRootSnapshot()).delegation?.code).toMatchObject({ kind: 'model', model, engine })
        );
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        const slider = dialog.querySelector<HTMLElement>('[role="slider"]')!;
        expect(slider).not.toBeNull();
        await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
        const effort = slider.getAttribute('aria-valuetext')!.toLowerCase();
        await vi.waitFor(async () =>
            expect((await transport.getRootSnapshot()).delegation?.code).toMatchObject({
                kind: 'model',
                model,
                engine,
                effort,
            })
        );
        const inherit = [...dialog.querySelectorAll('button')].find(
            button => button.textContent === 'Inherit orchestrator'
        )!;
        await press(inherit);
        await vi.waitFor(async () =>
            expect((await transport.getRootSnapshot()).delegation?.code).toEqual({ kind: 'inherit' })
        );
        await press(trigger);
        expect(document.querySelector('[role="dialog"] [role="slider"]')).toBeNull();
    });

    it('saves an effort change made while the model selection is still saving', async () => {
        const original = store.command.bind(store);
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let first = true;
        vi.spyOn(store, 'command').mockImplementation(async command => {
            if (command.type === 'settings.setDelegation' && first) {
                first = false;
                await gate;
            }
            return original(command);
        });
        await press(container.querySelector('[aria-label^="Code selection:"]')!);
        const dialog = document.querySelector('[role="dialog"]')!;
        await press(dialog.querySelector('[role="option"]')!);
        const slider = dialog.querySelector<HTMLElement>('[role="slider"]')!;
        await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
        const effort = slider.getAttribute('aria-valuetext')!.toLowerCase();
        await act(async () => release());
        await vi.waitFor(async () =>
            expect((await transport.getRootSnapshot()).delegation?.code).toMatchObject({ kind: 'model', effort })
        );
    });

    it('keeps a newer choice when a failed save is still reloading', async () => {
        const snapshot = await transport.getRootSnapshot();
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const read = vi.spyOn(transport, 'getRootSnapshot').mockImplementationOnce(async () => {
            await gate;
            return snapshot;
        });
        const original = store.command.bind(store);
        let first = true;
        vi.spyOn(store, 'command').mockImplementation(async command => {
            if (command.type === 'settings.setDelegation' && first) {
                first = false;
                return { ok: false, requestId: 'unsent', error: { code: 'unavailable', message: 'Offline' } };
            }
            return original(command);
        });
        const trigger = container.querySelector('[aria-label^="Code selection:"]')!;
        await press(trigger);
        await press(document.querySelector('[role="dialog"] [role="option"]')!);
        await vi.waitFor(() => expect(read).toHaveBeenCalled());
        const inherit = [...document.querySelectorAll('[role="dialog"] button')].find(
            button => button.textContent === 'Inherit orchestrator'
        )!;
        await press(inherit);
        await act(async () => release());
        await vi.waitFor(async () =>
            expect((await transport.getRootSnapshot()).delegation?.code).toEqual({ kind: 'inherit' })
        );
        expect(trigger.getAttribute('aria-label')).toBe('Code selection: Inherit orchestrator');
    });

    it('restores the last saved choice when saving and reloading both fail', async () => {
        vi.spyOn(store, 'command').mockResolvedValue({
            ok: false,
            requestId: 'unsent',
            error: { code: 'unavailable', message: 'Offline' },
        });
        vi.spyOn(transport, 'getRootSnapshot').mockRejectedValue(new Error('Offline'));
        const trigger = container.querySelector('[aria-label^="Code selection:"]')!;
        await press(trigger);
        await press(document.querySelector('[role="dialog"] [role="option"]')!);
        await vi.waitFor(() => expect(trigger.getAttribute('aria-label')).toBe('Code selection: Use default'));
        expect(document.querySelector('[role="dialog"] [role="slider"]')).toBeNull();
    });

    it('shows all roles and calls out a saved provider that is unavailable', () => {
        expect(
            ['Default', 'Research', 'Code', 'Review'].map(
                role => !!container.querySelector(`[aria-label^="${role} selection:"]`)
            )
        ).toEqual([true, true, true, true]);
        expect(container.textContent).toContain('The selected provider is unavailable or switched off');
        expect(container.textContent).toContain('old-model');
    });

    it('sets native subagents globally through the daemon', async () => {
        const command = vi.spyOn(store, 'command');
        const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Enable native subagents"]')!;
        expect(toggle.checked).toBe(true);
        await act(async () => toggle.click());
        await vi.waitFor(() =>
            expect(command).toHaveBeenCalledWith({ type: 'agents.setSharedSetting', id: 'subagents', enabled: false })
        );
        await vi.waitFor(() => expect(toggle.checked).toBe(false));
    });
});
