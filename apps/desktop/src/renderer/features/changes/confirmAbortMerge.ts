import { openConfirmModal } from '@clowdy/components/modals';

export function confirmAbortMerge(onConfirm: () => Promise<void>, operation: 'merge' | 'rebase' = 'merge'): void {
    openConfirmModal({
        title: `Abort ${operation}?`,
        message: `Any changes made to resolve this ${operation} will be discarded`,
        confirmLabel: `Abort ${operation}`,
        cancelVariant: 'filled',
        destructive: true,
        initialFocus: 'cancel',
        onConfirm,
    });
}
