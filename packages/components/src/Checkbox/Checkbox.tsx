import { Check, CheckSmall, CheckXsmall, MixedCheck, MixedCheckSmall, MixedCheckXsmalll } from '@clowdy/icons/12';
import { cn } from '@clowdy/lib';
import { Checkbox as RACCheckbox, type CheckboxProps as RACCheckboxProps } from 'react-aria-components';

import styles from './Checkbox.module.css';

import type { ReactNode } from 'react';

export type CheckboxSize = 'sm' | 'md' | 'lg';

const CHECK_ICON: Record<CheckboxSize, ReactNode> = {
    sm: <CheckXsmall />,
    md: <CheckSmall />,
    lg: <Check />,
};

const MIXED_ICON: Record<CheckboxSize, ReactNode> = {
    sm: <MixedCheckXsmalll />,
    md: <MixedCheckSmall />,
    lg: <MixedCheck />,
};

export interface CheckboxProps extends Omit<RACCheckboxProps, 'className' | 'children'> {
    size?: CheckboxSize;
    className?: RACCheckboxProps['className'];
    children?: ReactNode;
}

export function Checkbox({ size = 'md', className, children, ...props }: CheckboxProps) {
    return (
        <RACCheckbox
            {...props}
            className={renderProps =>
                cn(styles.root, typeof className === 'function' ? className(renderProps) : className)
            }
            data-size={size}
        >
            {renderProps => (
                <>
                    <span className={styles.box} aria-hidden>
                        <span
                            className={styles.icon}
                            data-visible={(renderProps.isSelected && !renderProps.isIndeterminate) || undefined}
                        >
                            {CHECK_ICON[size]}
                        </span>
                        <span className={styles.icon} data-visible={renderProps.isIndeterminate || undefined}>
                            {MIXED_ICON[size]}
                        </span>
                    </span>
                    {children != null ? <span className={styles.label}>{children}</span> : null}
                </>
            )}
        </RACCheckbox>
    );
}

Checkbox.displayName = 'Checkbox';
