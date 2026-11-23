import { cn } from '@clowdy/lib';
import {
    CheckboxGroup as RACCheckboxGroup,
    type CheckboxGroupProps as RACCheckboxGroupProps,
} from 'react-aria-components';

import { Checkbox } from './Checkbox';
import styles from './CheckboxGroup.module.css';

import type { ReactNode } from 'react';

export interface CheckboxGroupItem {
    value: string;
    label: ReactNode;
    isDisabled?: boolean;
}

export interface CheckboxGroupProps extends Omit<RACCheckboxGroupProps, 'children'> {
    className?: string;
    /** Static Checkbox nodes or a render function when using `items`. */
    children?: ReactNode | ((item: CheckboxGroupItem) => ReactNode);
    /** List of options to render as checkboxes. When provided, `children` can be a function (item) => ReactNode. */
    items?: Iterable<CheckboxGroupItem>;
}

function defaultRenderCheckbox(item: CheckboxGroupItem) {
    return (
        <Checkbox key={item.value} value={item.value} isDisabled={item.isDisabled}>
            {item.label}
        </Checkbox>
    );
}

export function CheckboxGroup({ className, items, children, ...props }: CheckboxGroupProps) {
    const content: ReactNode = ((): ReactNode => {
        if (items == null) {
            return typeof children === 'function' ? undefined : children;
        }

        const itemsArray = [...items];
        const renderItem = typeof children === 'function' ? children : defaultRenderCheckbox;

        return itemsArray.map((item): ReactNode => renderItem(item));
    })();

    return (
        <RACCheckboxGroup {...props} className={cn(styles.root, className)}>
            {content}
        </RACCheckboxGroup>
    );
}

CheckboxGroup.displayName = 'CheckboxGroup';
