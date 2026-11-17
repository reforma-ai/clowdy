// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModalContext } from '../Modal/hooks/useModalProvider';
import { confirmDiscardChanges } from '../modals/ConfirmModal';
import { SettingsLayout, useSettingsLayout, useSettingsSave } from './SettingsLayout';

import type { ModalInstance } from '../Modal/typings';

vi.mock('../modals/ConfirmModal', () => ({
    confirmDiscardChanges: vi.fn(() => Promise.resolve(true)),
}));

const ITEMS = [
    { id: 'general', label: 'General' },
    { id: 'security', label: 'Security' },
];

let host: HTMLDivElement;
let root: Root;

const modal = {
    unsaved: vi.fn(),
    saved: vi.fn(),
} as unknown as ModalInstance;

function Probe() {
    const { selectedId, select } = useSettingsLayout();
    const { onDirtyChange } = useSettingsSave();

    return (
        <div>
            <span data-selected>{ selectedId }</span>
            <button type="button" onClick={ () => onDirtyChange(true) }>Mark dirty</button>
            <button type="button" onClick={ () => select('security') }>Leave</button>
        </div>
    );
}

function renderLayout() {
    act(() => {
        root.render(
            <ModalContext value={ { modal, store: undefined } }>
                <SettingsLayout items={ ITEMS }>
                    <SettingsLayout.Content saveable footer={ <div>Publish later</div> }>
                        <Probe />
                    </SettingsLayout.Content>
                </SettingsLayout>
            </ModalContext>
        );
    });
}

function selectedId() {
    return host.querySelector('[data-selected]')?.textContent;
}

/** The unsaved-changes notice that replaces the footer while a section is dirty. */
function saveNotice() {
    return host.querySelector('[role="alert"]');
}

function buttonNamed(name: string) {
    const button = [...host.querySelectorAll('button')].find(item => item.textContent === name);

    if (!button) {
        throw new Error(`Missing button ${ name }`);
    }

    return button;
}

beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    root = createRoot(host);
    vi.mocked(confirmDiscardChanges).mockReset();
    vi.mocked(confirmDiscardChanges).mockResolvedValue(true);
    modal.unsaved = vi.fn();
    modal.saved = vi.fn();
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    host.remove();
});

describe('SettingsLayout', () => {
    it('leaves a clean section without asking', () => {
        renderLayout();

        act(() => {
            buttonNamed('Leave').click();
        });

        expect(confirmDiscardChanges).not.toHaveBeenCalled();
        expect(selectedId()).toBe('security');
    });

    it('keeps a dirty section until the changes are discarded', async() => {
        vi.mocked(confirmDiscardChanges).mockResolvedValue(false);
        renderLayout();

        act(() => {
            buttonNamed('Mark dirty').click();
        });

        expect(saveNotice()?.textContent).toMatch(/\S/);
        expect(saveNotice()?.querySelector('button')).not.toBeNull();
        expect(host.textContent).not.toContain('Publish later');
        expect(modal.unsaved).toHaveBeenCalled();

        await act(async() => {
            buttonNamed('Leave').click();
        });

        expect(confirmDiscardChanges).toHaveBeenCalledOnce();
        expect(selectedId()).toBe('general');
        expect(saveNotice()).not.toBeNull();
    });

    it('leaves a dirty section after discard and brings the footer back', async() => {
        renderLayout();

        act(() => {
            buttonNamed('Mark dirty').click();
        });

        await act(async() => {
            buttonNamed('Leave').click();
        });

        expect(selectedId()).toBe('security');
        expect(host.textContent).toContain('Publish later');
        expect(saveNotice()).toBeNull();
    });
});
