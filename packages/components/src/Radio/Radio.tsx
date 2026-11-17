import { cn } from '@clowdy/lib';
import { use, type ReactNode } from 'react';
import { Radio as RACRadio, type RadioProps as RACRadioProps } from 'react-aria-components';

import styles from './Radio.module.css';
import { RadioContext } from './Radio.types';

export type RadioSize = 'sm' | 'md' | 'lg';

export interface RadioProps extends Omit<RACRadioProps, 'className' | 'children'> {
    size?: RadioSize;
    className?: RACRadioProps['className'];
    children?: ReactNode;
}

export function Radio({ size: sizeProp, className, children, ...props }: RadioProps) {
    const context = use(RadioContext);
    const size = sizeProp ?? context?.size ?? 'md';

    return (
        <RACRadio
            { ...props }
            className={ renderProps => cn(
                styles.root,
                typeof className === 'function' ? className(renderProps) : className
            ) }
            data-size={ size }
        >
            <span className={ styles.box } aria-hidden>
                <span className={ styles.dot } />
            </span>

            { children != null ? <span className={ styles.label }>{ children }</span> : null }
        </RACRadio>
    );
}

Radio.displayName = 'Radio';
