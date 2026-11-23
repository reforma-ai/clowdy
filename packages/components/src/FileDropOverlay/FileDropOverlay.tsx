import { SendBold } from '@clowdy/icons/16';
import { cn } from '@clowdy/lib';

import { Box } from '../Box';
import { Text } from '../Text';
import styles from './FileDropOverlay.module.css';

import type { HTMLAttributes, ReactNode } from 'react';

export type FileDropOverlayProps = HTMLAttributes<HTMLDivElement> & {
    open: boolean;
    /** Default centered label when `children` is omitted. */
    label?: ReactNode;
    /** Overrides the default send icon above `label`. Pass `null` to hide. */
    icon?: ReactNode | null;
    /** Full custom overlay content; replaces label + icon layout. */
    children?: ReactNode;
};

/** Full-bleed drop affordance while files are dragged over a region. */
export function FileDropOverlay({
    open,
    label,
    icon = <SendBold />,
    className,
    children,
    ...props
}: FileDropOverlayProps) {
    if (!open) {
        return null;
    }

    return (
        <div className={cn(styles.overlay, className)} {...props}>
            {children ?? (
                <Box direction="column" align="center" gap="lg" padding="md" className="text-center">
                    {icon != null ? (
                        <span className={styles.iconRing} aria-hidden>
                            {icon}
                        </span>
                    ) : null}

                    {label != null ? <Text>{label}</Text> : null}
                </Box>
            )}
        </div>
    );
}

FileDropOverlay.displayName = 'FileDropOverlay';
