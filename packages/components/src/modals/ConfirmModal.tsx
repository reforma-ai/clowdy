import { AttentionCircle } from '@clowdy/icons/14';
import { useState } from 'react';

import { Alert, AlertDescription, AlertIcon } from '../Alert';
import { Box } from '../Box';
import { Button } from '../Button';
import { Modal, useModalContext, useModalTitleId } from '../Modal';
import { Show } from '../Show';
import { Text } from '../Text';
import { toast } from '../Toast';
import { Z_INDEX } from './layers';

import type { ReactNode } from 'react';
import type { ModalOptionsRaw } from '../Modal/typings';

export type OpenConfirmModalOptions = {
    title: string;
    message: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    cancelVariant?: 'bordered' | 'filled';
    /** Omit Cancel. The confirm button is the only action. */
    showCancel?: boolean;
    destructive?: boolean;
    /**
     * Which button takes the focus when the dialog opens: Confirm, as most dialogs want, or Cancel, for an action that cannot be taken back. With Cancel, Enter on the dialog's own
     * body (not on a button) does not confirm either: Enter does what the focused button does and nothing else.
     */
    initialFocus?: 'confirm' | 'cancel';
    /**
     * Where a failure of `onConfirm` is said: in a toast, which is the default, or in the dialog, under the message, where the person is looking. Either way the dialog stays open and
     * its buttons are back, and the next press tries again.
     */
    errorIn?: 'toast' | 'dialog';
    /** Keeps Confirm off (a choice in the message is still missing); Enter does not confirm either. */
    isConfirmDisabled?: boolean;
    onConfirm: () => void | Promise<void>;
};

const DEFAULT_MODAL_OPTIONS: ModalOptionsRaw = {
    shadow: true,
    width: 380,
    clickOut: true,
    closeOnEscape: true,
    closeButton: false,
    role: 'alertdialog',
    zIndex: Z_INDEX.confirm,
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
    cancelVariant = 'bordered',
    showCancel = true,
    destructive,
    initialFocus = 'confirm',
    errorIn = 'toast',
    isConfirmDisabled = false,
    onConfirm,
}: OpenConfirmModalOptions) {
    const { modal } = useModalContext();
    const titleId = useModalTitleId();
    const [isPending, setIsPending] = useState(false);
    const [failure, setFailure] = useState<string | undefined>();

    const handleConfirm = async () => {
        if (isPending || isConfirmDisabled) {
            return;
        }

        setFailure(undefined);
        setIsPending(true);
        // Escape, an outside click or a close button would leave the action running with nothing on screen to say how it ends.
        modal.setDismissable(false);

        try {
            await onConfirm();
            modal.setDismissable(true);
            modal.cancel();
        } catch (error) {
            setIsPending(false);
            modal.setDismissable(true);

            const message = error instanceof Error ? error.message : 'Something went wrong. Please try again.';

            if (errorIn === 'dialog') {
                setFailure(message);
            } else {
                toast.error({ message });
            }
        }
    };

    return (
        <Box
            gap="xl"
            padding="xxl"
            onKeyDown={event => {
                if (
                    event.key !== 'Enter' ||
                    event.defaultPrevented ||
                    isPending ||
                    isConfirmDisabled ||
                    initialFocus === 'cancel'
                ) {
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
                <Text as="h2" variant="heading-3" id={titleId} wrap="anywhere" className="m-0">
                    {title}
                </Text>
                {typeof message === 'string' ? (
                    <Text variant="md" color="secondary">
                        {message}
                    </Text>
                ) : (
                    message
                )}
                <Show when={failure}>
                    {text => (
                        <Alert color="danger">
                            <AlertIcon>
                                <AttentionCircle />
                            </AlertIcon>
                            <AlertDescription className="select-text">{text}</AlertDescription>
                        </Alert>
                    )}
                </Show>
            </Box>

            <Box
                direction="row"
                gap="md"
                fullWidth
                justify={showCancel ? undefined : 'end'}
                equalWidth={showCancel || undefined}
            >
                <Show when={showCancel}>
                    <Button
                        variant={cancelVariant}
                        autoFocus={initialFocus === 'cancel'}
                        isDisabled={isPending}
                        onPress={() => modal.cancel()}
                    >
                        {cancelLabel}
                    </Button>
                </Show>

                <Button
                    autoFocus={initialFocus === 'confirm' || !showCancel}
                    color={destructive ? 'danger' : 'primary'}
                    isPending={isPending}
                    isDisabled={isPending || isConfirmDisabled}
                    onPress={() => void handleConfirm()}
                >
                    {confirmLabel}
                </Button>
            </Box>
        </Box>
    );
}
