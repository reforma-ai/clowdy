import { openConfirmModal } from '@clowdy/components/modals';

export function confirmAbortMerge(onConfirm: () => Promise<void>): void {
    openConfirmModal({
        title: 'Abort merge?',
        message: 'Any changes made to resolve this merge will be discarded',
        confirmLabel: 'Abort merge',
        cancelVariant: 'filled',
        destructive: true,
        initialFocus: 'cancel',
        onConfirm,
    });
}
