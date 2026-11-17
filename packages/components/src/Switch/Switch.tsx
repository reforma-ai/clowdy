import { cn } from '@clowdy/lib';
import { Switch as RACSwitch, type SwitchProps as RACSwitchProps } from 'react-aria-components';

import { Show } from '../Show';
import { useSlotContextProps } from '../Slot';
import { Spinner } from '../Spinner';
import styles from './Switch.module.css';

import type { ReactNode } from 'react';

export type SwitchSize = 'sm' | 'md' | 'lg';

export interface SwitchProps extends Omit<RACSwitchProps, 'children'> {
    size?: SwitchSize;
    className?: string;
    children?: ReactNode;
    isPending?: boolean;
}

export function Switch(props: SwitchProps) {
    const {
        size = 'md',
        className,
        children,
        isPending,
        isReadOnly,
        ...switchProps
    } = useSlotContextProps(props);

    return (
        <RACSwitch
            { ...switchProps }
            className={ cn(styles.root, className) }
            data-size={ size }
            data-pending={ isPending || undefined }
            isReadOnly={ isReadOnly || isPending }
            aria-busy={ isPending || undefined }
        >
            <span className={ styles.track }>
                <span className={ styles.handle }>
                    <Show when={ isPending }>
                        <Spinner size="inherit" className={ styles.spinner } aria-hidden="true" />
                    </Show>
                </span>
            </span>

            { children }
        </RACSwitch>
    );
}

Switch.displayName = 'Switch';
