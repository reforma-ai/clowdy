// @vitest-environment happy-dom
import { openConfirmModal } from '@clowdy/components/modals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportError } from '../../../daemon/transport';
import { RecommendedSkill } from './RecommendedSkill';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const transport = vi.hoisted(() => ({
    getBriefbackStatus: vi.fn(),
    installBriefback: vi.fn(),
    checkBriefbackUpdate: vi.fn(),
}));
vi.mock('../../../stores', () => ({ useRootStore: () => ({ transport }) }));
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));

const missing = {
    copies: [
        { exists: false, installed: false },
        { exists: false, installed: false },
    ],
    fingerprint: 'first',
};
const complete = {
    copies: [
        { exists: true, installed: true },
        { exists: true, installed: true },
    ],
    fingerprint: 'done',
};
let container: HTMLDivElement;
let root: Root;
const onInstalled = vi.fn();

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
const press = async (target: Element) => {
    await act(async () => {
        target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        target.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        (target as HTMLElement).click();
    });
};
const button = () => container.querySelector<HTMLButtonElement>('[data-testid="briefback-install"]')!;
const status = () => container.querySelector('[data-testid="briefback-status"]')?.textContent;

beforeEach(async () => {
    vi.clearAllMocks();
    transport.getBriefbackStatus.mockResolvedValue(missing);
    transport.installBriefback.mockImplementation(async () => {
        transport.getBriefbackStatus.mockResolvedValue(complete);
        return complete;
    });
    transport.checkBriefbackUpdate.mockResolvedValue('up-to-date');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<RecommendedSkill onInstalled={onInstalled} revision={0} />));
    await settle();
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

describe('Briefback recommendation', () => {
    it('asks before installing and leaves the filesystem alone when the dialog is canceled', async () => {
        await press(button());
        expect(openConfirmModal).toHaveBeenCalledOnce();
        expect(transport.installBriefback).not.toHaveBeenCalled();
        expect(status()).toBe('Not installed');
    });

    it('shows progress and installed state only after a confirmed install succeeds', async () => {
        let finish!: (value: typeof complete) => void;
        transport.installBriefback.mockReturnValue(
            new Promise(resolve => {
                finish = resolve;
            })
        );
        await press(button());
        const dialog = vi.mocked(openConfirmModal).mock.lastCall![0];
        let operation!: Promise<void>;
        await act(async () => {
            operation = Promise.resolve(dialog.onConfirm());
        });
        expect(button().disabled).toBe(true);
        expect(container.querySelector('[role="status"]')).not.toBeNull();
        expect(transport.installBriefback).toHaveBeenCalledWith('first');
        await act(async () => {
            transport.getBriefbackStatus.mockResolvedValue(complete);
            finish(complete);
            await operation;
        });
        expect(status()).toBe('Installed');
        expect(onInstalled).toHaveBeenCalledOnce();
    });

    it('keeps a failed installation recoverable after checking the current filesystem state', async () => {
        transport.installBriefback.mockRejectedValueOnce(new Error('offline'));
        transport.getBriefbackStatus.mockResolvedValueOnce({
            copies: [complete.copies[0], missing.copies[1]],
            fingerprint: 'changed',
        });
        await press(button());
        await act(async () => {
            await vi.mocked(openConfirmModal).mock.lastCall![0].onConfirm();
        });
        expect(status()).toBe('Partially installed');
        expect(container.querySelector('[role="alert"]')).not.toBeNull();
        expect(button().disabled).toBe(false);
        await press(button());
        await act(async () => {
            await vi.mocked(openConfirmModal).mock.lastCall![0].onConfirm();
        });
        expect(transport.installBriefback).toHaveBeenLastCalledWith('changed');
        expect(status()).toBe('Installed');
    });
    it('keeps the backup location visible if installation and the following status check fail', async () => {
        transport.installBriefback.mockRejectedValueOnce(new TransportError('Backup kept in /tmp/briefback', 503));
        transport.getBriefbackStatus.mockRejectedValueOnce(new Error('offline'));
        await press(button());
        await act(async () => {
            await vi.mocked(openConfirmModal).mock.lastCall![0].onConfirm();
        });
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('/tmp/briefback');
    });

    it('offers an update only after it has checked that one exists', async () => {
        transport.checkBriefbackUpdate.mockResolvedValue('update-available');
        await press(button());
        await act(async () => {
            await vi.mocked(openConfirmModal).mock.lastCall![0].onConfirm();
        });
        await settle();
        expect(status()).toBe('Installed');
        expect(button().textContent).toBe('Update');
        await press(button());
        expect(vi.mocked(openConfirmModal).mock.lastCall![0].confirmLabel).toBe('Update');
        await act(async () => {
            await vi.mocked(openConfirmModal).mock.lastCall![0].onConfirm();
        });
        expect(transport.installBriefback).toHaveBeenLastCalledWith('done');
    });

    it('does not offer an update when the installed copy is current', async () => {
        await press(button());
        await act(async () => {
            await vi.mocked(openConfirmModal).mock.lastCall![0].onConfirm();
        });
        await settle();
        expect(status()).toBe('Installed');
        expect(container.querySelector('[data-testid="briefback-update-status"]')?.textContent).toBe('Up to date');
        expect(button()).toBeNull();
    });

    it('allows a failed update check to be retried', async () => {
        transport.checkBriefbackUpdate
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce('update-available');
        await press(button());
        await act(async () => {
            await vi.mocked(openConfirmModal).mock.lastCall![0].onConfirm();
        });
        await settle();
        expect(button()).toBeNull();
        const retry = [...container.querySelectorAll('button')].find(
            candidate => candidate.textContent === 'Check again'
        )!;
        await press(retry);
        await settle();
        expect(button().textContent).toBe('Update');
    });
    it('refreshes installation state when the skills catalog changes', async () => {
        transport.getBriefbackStatus.mockResolvedValue(complete);
        await act(async () => root.render(<RecommendedSkill onInstalled={onInstalled} revision={1} />));
        await settle();
        expect(status()).toBe('Installed');
        expect(transport.checkBriefbackUpdate).toHaveBeenCalledWith('done');
    });
});
