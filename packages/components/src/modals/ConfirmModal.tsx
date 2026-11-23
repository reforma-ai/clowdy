import { useState } from 'react';

import { Box } from '../Box';
import { Button } from '../Button';
import { Modal, useModalContext } from '../Modal';
import { Show } from '../Show';
import { Text } from '../Text';
import { toast } from '../Toast';

import type { ReactNode } from 'react';
import type { ModalOptionsRaw } from '../Modal/typings';

export type OpenConfirmModalOptions = {
    title: string;
    message: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Omit Cancel. The confirm button is the only action. */
    showCancel?: boolean;
    destructive?: boolean;
    onConfirm: () => void | Promise<void>;
};

/** Keep in sync with `--z-confirm` in `@clowdy/styles`. */
const CONFIRM_MODAL_Z_INDEX = 101100;

const DEFAULT_MODAL_OPTIONS: ModalOptionsRaw = {
    shadow: true,
    width: 380,
    clickOut: true,
    closeOnEscape: true,
    closeButton: false,
    zIndex: CONFIRM_MODAL_Z_INDEX,
};

let pendingDiscard: Promise<boolean> | null = null;

/** Discard dialog for a dirty form. Resolves true only when the person discards. */
export function confirmDiscardChanges(): Promise<boolean> {
    if (pendingDiscard) {
        return pendingDiscard;
    }

    const dialog = new Promise<boolean>(resolve => {
        let settled = false;

        const finish = (discard: boolean) => {
            if (settled) {
                return;
            }

            settled = true;
            resolve(discard);
        };

        openConfirmModal(
            {
                title: 'Unsaved changes',
                message: 'Discard them, or go back and save',
                confirmLabel: 'Discard changes',
                cancelLabel: 'Go back',
                destructive: true,
                onConfirm: () => {
                    finish(true);
                },
            },
            {
                onCancel: () => finish(false),
                onClose: () => finish(false),
            }
        );
    });

    pendingDiscard = dialog;
    void dialog.finally(() => {
        pendingDiscard = null;
    });

    return dialog;
}

export function openConfirmModal(options: OpenConfirmModalOptions, modalOptions?: ModalOptionsRaw) {
    return Modal.create({
        ...DEFAULT_MODAL_OPTIONS,
        ...modalOptions,
        component: <ConfirmModalContent {...options} />,
    });
}

export function ConfirmModalContent({
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    showCancel = true,
    destructive,
    onConfirm,
}: OpenConfirmModalOptions) {
    const { modal } = useModalContext();
    const [isPending, setIsPending] = useState(false);

    const handleConfirm = async () => {
        if (isPending) {
            return;
        }

        setIsPending(true);
        const { clickOut, closeOnEscape } = modal.currentOptions;
        modal.updateOptions({ clickOut: false, closeOnEscape: false });

        try {
            await onConfirm();
            modal.cancel();
        } catch (error) {
            setIsPending(false);
            modal.updateOptions({ clickOut, closeOnEscape });
            toast.error({
                message: error instanceof Error ? error.message : 'Something went wrong. Please try again.',
            });
        }
    };

    return (
        <Box
            gap="xl"
            padding="xxl"
            onKeyDown={event => {
                if (event.key !== 'Enter' || event.defaultPrevented || isPending) {
                    return;
                }

                // Overlay / non-button focus: Enter confirms. Focused Cancel still cancels via its own activation.
                if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) {
                    return;
                }

                event.preventDefault();
                void handleConfirm();
            }}
        >
            <Box gap="md">
                <Text variant="heading-3">{title}</Text>
                {typeof message === 'string' ? (
                    <Text variant="md" color="secondary">
                        {message}
                    </Text>
                ) : (
                    message
                )}
            </Box>

            <Box
                direction="row"
                gap="md"
                fullWidth
                justify={showCancel ? undefined : 'end'}
                equalWidth={showCancel || undefined}
            >
                <Show when={showCancel}>
                    <Button variant="bordered" isDisabled={isPending} onPress={() => modal.cancel()}>
                        {cancelLabel}
                    </Button>
                </Show>

                <Button
                    autoFocus
                    color={destructive ? 'danger' : 'primary'}
                    isPending={isPending}
                    isDisabled={isPending}
                    onPress={() => void handleConfirm()}
                >
                    {confirmLabel}
                </Button>
            </Box>
        </Box>
    );
}
