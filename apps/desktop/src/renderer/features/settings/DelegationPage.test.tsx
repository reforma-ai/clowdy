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
    it('uses one selector per role to choose a model, inherit, and return to default', async () => {
        const trigger = container.querySelector('[aria-label^="Code selection:"]')!;
        expect(container.querySelectorAll('[aria-label^="Code selection:"]')).toHaveLength(1);
        expect(trigger.getAttribute('aria-label')).toBe('Code selection: Use default');
        expect(container.querySelectorAll('button[aria-label^="Model:"]')).toHaveLength(0);
        await press(trigger);
        const dialog = document.querySelector('[role="dialog"][aria-label="Model and reasoning effort"]')!;
        expect(dialog.textContent).toContain('Use default');
        expect(dialog.textContent).toContain('Inherit orchestrator');
        expect((await transport.getRootSnapshot()).delegation?.code).toBeUndefined();
        await press(dialog.querySelector('button[aria-label="Select model"]')!);
        await vi.waitFor(() =>
            expect(document.querySelectorAll('[role="dialog"] [role="option"]').length).toBeGreaterThan(0)
        );
        await press(document.querySelector('[role="dialog"] [role="option"]')!);
        await vi.waitFor(async () => expect((await transport.getRootSnapshot()).delegation?.code?.kind).toBe('model'));
        const inherit = [...document.querySelectorAll('[role="dialog"] button')].find(
            button => button.textContent === 'Inherit orchestrator'
        )!;
        await press(inherit);
        await vi.waitFor(() => expect(trigger.getAttribute('aria-label')).toBe('Code selection: Inherit orchestrator'));
        await vi.waitFor(async () =>
            expect((await transport.getRootSnapshot()).delegation?.code).toEqual({ kind: 'inherit' })
        );
        await press(trigger);
        const fallback = [...document.querySelectorAll('[role="dialog"] button')].find(
            button => button.textContent === 'Use default'
        )!;
        await press(fallback);
        await vi.waitFor(async () => expect((await transport.getRootSnapshot()).delegation?.code).toBeUndefined());
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
