import { Check, Copy } from '@clowdy/icons/14';
import { useEffect, useRef, useState } from 'react';

import { Button, type ButtonProps } from '../Button';
import { toast } from '../Toast';
import { Tooltip } from '../Tooltip';
import styles from './CopyButton.module.css';

const COPIED_MS = 1500;

export async function copyText(value: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(value);

        return true;
    } catch {
        return false;
    }
}

/** Copy `value`, then `onCopied` or an error toast. */
export function copyWithFeedback(value: string, onCopied: () => void) {
    void copyText(value).then(ok => {
        if (ok) {
            onCopied();

            return;
        }

        toast.error({ message: "Couldn't copy" });
    });
}

export function useCopyFeedback(duration = COPIED_MS) {
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => () => clearTimeout(timerRef.current), []);

    const markCopied = () => {
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), duration);
    };

    return { copied, markCopied };
}

export interface CopyButtonProps extends Omit<ButtonProps, 'href' | 'target' | 'rel' | 'onPress'> {
    value: string;
    copiedLabel?: string;
}

export function CopyButton({
    value,
    copiedLabel = 'Copied',
    children,
    tooltip,
    tooltipPlacement,
    iconOnly = children == null,
    ...buttonProps
}: CopyButtonProps) {
    const { copied, markCopied } = useCopyFeedback();
    const idleContent = tooltip ?? 'Copy';
    const button = (
        <Button {...buttonProps} iconOnly={iconOnly} onPress={() => copyWithFeedback(value, markCopied)}>
            <span className={styles.icons} data-copied={copied || undefined} aria-hidden>
                <span className={styles.idle}>{iconOnly ? (children ?? <Copy />) : <Copy />}</span>
                <span className={styles.done}>
                    <Check />
                </span>
            </span>
            {!iconOnly && children}
        </Button>
    );

    if (!iconOnly && tooltip == null) {
        return button;
    }

    return (
        <Tooltip
            content={copied ? copiedLabel : idleContent}
            delay={copied ? 0 : undefined}
            isOpen={copied ? true : undefined}
            placement={tooltipPlacement}
            shouldCloseOnPress={false}
        >
            {button}
        </Tooltip>
    );
}
