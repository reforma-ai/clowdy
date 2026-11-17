import { cn } from '@clowdy/lib';
import { useMemo, type ReactNode } from 'react';
import {
    RadioGroup as RACRadioGroup,
    type RadioGroupProps as RACRadioGroupProps,
} from 'react-aria-components';

import { Radio } from './Radio';
import { RadioContext, type RadioSize } from './Radio.types';
import styles from './RadioGroup.module.css';

export interface RadioGroupItem {
    value: string;
    label: ReactNode;
    isDisabled?: boolean;
}

export interface RadioGroupProps extends Omit<RACRadioGroupProps, 'children'> {
    size?: RadioSize;
    className?: string;
    /** Static Radio nodes or a render function when using `items`. */
    children?: ReactNode | ((item: RadioGroupItem) => ReactNode);
    /** List of options to render as radios. When provided, `children` can be a function (item) => ReactNode. */
    items?: Iterable<RadioGroupItem>;
}

function defaultRenderRadio(item: RadioGroupItem) {
    return (
        <Radio key={ item.value } value={ item.value } isDisabled={ item.isDisabled }>
            { item.label }
        </Radio>
    );
}

export function RadioGroup({
    size = 'md',
    className,
    items,
    children,
    ...props
}: RadioGroupProps) {
    const contextValue = useMemo(
        () => ({ size }),
        [size]
    );

    const content: ReactNode = ((): ReactNode => {
        if (items == null) {
            return typeof children === 'function' ? undefined : children;
        }

        const itemsArray = [...items];
        const renderItem = typeof children === 'function' ? children : defaultRenderRadio;

        return itemsArray.map((item): ReactNode => renderItem(item));
    })();

    return (
        <RadioContext value={ contextValue }>
            <RACRadioGroup
                { ...props }
                className={ cn(styles.root, className) }
                data-size={ size }
            >
                { content }
            </RACRadioGroup>
        </RadioContext>
    );
}

RadioGroup.displayName = 'RadioGroup';
