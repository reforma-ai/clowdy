// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { branchPrefix } from '../chats/branchPrefix';
import { SourceControlPage } from './SourceControlPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let store: RootStore;
const prefixField = () => container.querySelector<HTMLInputElement>('input[aria-label="Branch prefix"]')!;
const prefixNote = () => container.querySelector('[role="alert"]')?.textContent;
beforeEach(async () => {
    branchPrefix.setValue('');
    store = new RootStore(new FixtureTransport(), { storage: undefined });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <SourceControlPage />
            </RootStoreProvider>
        )
    );
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    branchPrefix.setValue('');
});

describe('the branch prefix of a new worktree', () => {
    const type = (text: string) =>
        act(() => {
            prefixField().focus();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(prefixField(), text);
            prefixField().dispatchEvent(new Event('input', { bubbles: true }));
        });
    const leave = () => act(() => prefixField().blur());

    it('is clowdy at first, with a line that says what it does and no period after it', () => {
        expect(prefixField().value).toBe('clowdy');
        expect(container.textContent).toContain('Branches of new worktrees are named like clowdy/ab12cd34');
        expect(container.textContent).not.toContain('such as clowdy/ab12cd34.');
        expect(prefixNote()).toBeUndefined();
    });

    it('keeps a prefix on this computer as it is typed, and shows it in the example', () => {
        type('max');

        expect(branchPrefix.value).toBe('max');
        expect(localStorage.getItem('clowdy:branch-prefix')).toBe('"max"');
        expect(container.textContent).toContain('named like max/ab12cd34');
        expect(prefixNote()).toBeUndefined();

        type('team/max');
        leave();

        expect(branchPrefix.value).toBe('team/max');
        expect(prefixField().value).toBe('team/max');
    });

    it('says why a prefix is refused, keeps the one that was in force, and shows the box as it was typed until it is fixed', () => {
        type('max');
        type('two words');

        expect(prefixNote()).toBe('The branch prefix cannot have a space or a control character');
        expect(prefixField().getAttribute('aria-invalid')).toBe('true');
        expect(branchPrefix.value).toBe('max');
        expect(localStorage.getItem('clowdy:branch-prefix')).toBe('"max"');

        // Leaving the box does not make a refused text the setting, nor throw it away.
        leave();

        expect(prefixField().value).toBe('two words');
        expect(prefixNote()).toBeDefined();

        type('two-words');

        expect(prefixNote()).toBeUndefined();
        expect(branchPrefix.value).toBe('two-words');
    });

    it('is the default again when the box is emptied, and shows it once the box is left', () => {
        type('max');
        type('');

        expect(branchPrefix.value).toBe('clowdy');
        expect(prefixNote()).toBeUndefined();

        leave();

        expect(prefixField().value).toBe('clowdy');
    });
});
