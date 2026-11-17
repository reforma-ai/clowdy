import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button, type ButtonColor, type ButtonProps, type ButtonVariant } from '../Button';
import { useClickout } from '../hooks';
import styles from './ConfirmButton.module.css';

const RESET_AFTER_LEAVE_MS = 5_000;

export interface ConfirmButtonProps extends Omit<ButtonProps, 'href' | 'target' | 'rel' | 'onPress' | 'isPressed'> {
    onConfirm: () => void | Promise<void>;
    confirmLabel?: ReactNode;
    confirmColor?: ButtonColor;
    confirmVariant?: ButtonVariant;
}

export function ConfirmButton({
    children,
    color,
    variant,
    confirmColor,
    confirmVariant,
    confirmLabel = 'Confirm',
    onConfirm,
    isPending: isPendingProp,
    isDisabled,
    ...buttonProps
}: ConfirmButtonProps) {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState(false);
    const busy = Boolean(isPendingProp || pending);

    const clearResetTimer = () => {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = undefined;
    };

    const reset = () => {
        if (busy) {
            return;
        }

        clearResetTimer();
        setConfirming(false);
    };

    const scheduleReset = () => {
        if (busy || !confirming) {
            return;
        }

        clearResetTimer();
        resetTimerRef.current = setTimeout(() => {
            resetTimerRef.current = undefined;
            reset();
        }, RESET_AFTER_LEAVE_MS);
    };

    useEffect(() => () => {
        clearResetTimer();
    }, []);

    useClickout({
        enabled: confirming && !busy,
        roots: buttonRef,
        onClickout: reset,
    });

    useEffect(() => {
        if (!confirming || busy) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
                return;
            }

            event.stopPropagation();
            clearResetTimer();
            setConfirming(false);
        };

        document.addEventListener('keydown', onKeyDown);

        return () => document.removeEventListener('keydown', onKeyDown);
    }, [ confirming, busy ]);

    const confirm = async() => {
        if (busy) {
            return;
        }

        clearResetTimer();
        setPending(true);

        try {
            await onConfirm();
        }
        finally {
            setPending(false);
            setConfirming(false);
        }
    };

    return (
        <Button
            { ...buttonProps }
            ref={ buttonRef }
            color={ confirming ? (confirmColor ?? color) : color }
            variant={ confirming ? (confirmVariant ?? variant) : variant }
            isDisabled={ isDisabled }
            isPending={ busy }
            onPointerEnter={ confirming ? clearResetTimer : undefined }
            onPointerLeave={ confirming ? scheduleReset : undefined }
            onBlur={ (event) => {
                const next = event.relatedTarget;

                if (next instanceof Node && buttonRef.current?.contains(next)) {
                    return;
                }

                scheduleReset();
            } }
            onPress={ () => {
                if (confirming) {
                    void confirm();

                    return;
                }

                setConfirming(true);
            } }
        >
            <span className={ styles.labels } data-confirming={ confirming || undefined }>
                <span className={ styles.measure } aria-hidden="true">{ confirmLabel }</span>
                <span className={ styles.idle } aria-hidden={ confirming || undefined }>{ children }</span>
                <span className={ styles.confirm } aria-hidden={ !confirming || undefined }>{ confirmLabel }</span>
            </span>
        </Button>
    );
}

ConfirmButton.displayName = 'ConfirmButton';
