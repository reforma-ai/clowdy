import { cn } from '@clowdy/lib';
import { Keyboard as AriaKeyboard } from 'react-aria-components';

import { Text } from '../Text';
import styles from './Hotkey.module.css';
import { hotkeysToSymbols, type HotkeyValue } from './hotkeysToSymbols';

import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react';
import type { TextVariant } from '../types';

type AriaKeyboardProps = ComponentPropsWithoutRef<typeof AriaKeyboard>;

export type HotkeySize = 'xs' | 'sm' | 'md';

const SIZE_TEXT_VARIANT: Record<HotkeySize, TextVariant> = {
    xs: 'xs',
    sm: 'sm',
    md: 'md',
};

export interface HotkeyProps extends Omit<AriaKeyboardProps, 'children' | 'className'> {
    ref?: Ref<HTMLElement>;
    className?: string;
    hotkey?: HotkeyValue;
    /** Capsule scale. Drives default type size; override with `textVariant`. */
    size?: HotkeySize;
    /** Type size. Omit to follow `size`; pass `false` to inherit ambient typography. */
    textVariant?: TextVariant | false;
    children?: ReactNode;
}

export function Hotkey({
    ref,
    className,
    hotkey,
    size = 'xs',
    textVariant,
    children,
    ...props
}: HotkeyProps) {
    const content = children ?? (hotkey != null ? hotkeysToSymbols(hotkey).join(' ') : undefined);
    const variant = textVariant === false
        ? undefined
        : (textVariant ?? SIZE_TEXT_VARIANT[size]);

    return (
        <AriaKeyboard
            { ...props }
            ref={ ref }
            data-hotkey=""
            data-size={ size }
            className={ cn(styles.hotkey, className) }
        >
            <Text
                as="span"
                variant={ variant }
                color="inherit"
                whitespace="nowrap"
            >
                {content}
            </Text>
        </AriaKeyboard>
    );
}

Hotkey.displayName = 'Hotkey';

/** Label + shortcut for Button / ToggleButton tooltips. */
export function tooltipWithHotkey(label: string, hotkey: HotkeyValue): ReactNode {
    return (
        <>
            { label }
            { ' ' }
            <Hotkey hotkey={ hotkey } size="xs" />
        </>
    );
}
