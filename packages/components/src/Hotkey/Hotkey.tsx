import { cn } from '@clowdy/lib';
import { Fragment } from 'react';
import { Keyboard as AriaKeyboard } from 'react-aria-components';

import { Text } from '../Text';
import styles from './Hotkey.module.css';
import { type HotkeyValue, hotkeysToSymbols } from './hotkeysToSymbols';

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
    /**
     * Presses typed one after another, one capsule each, joined by a quiet "then": `[['g'], ['c']]` shows "G then C".
     * Takes the place of `hotkey` and `children`. `ref` and the other props go to the wrapper.
     */
    sequence?: readonly HotkeyValue[];
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
    sequence,
    size = 'xs',
    textVariant,
    children,
    ...props
}: HotkeyProps) {
    const variant = textVariant === false ? undefined : (textVariant ?? SIZE_TEXT_VARIANT[size]);

    if (sequence) {
        return (
            <span
                {...props}
                ref={ref}
                data-hotkey-sequence=""
                data-size={size}
                className={cn(styles.sequence, className)}
            >
                {sequence.map((press, index) => (
                    // A sequence never reorders, so the position is the identity of a press.
                    <Fragment key={index}>
                        {index > 0 && (
                            <Text
                                as="span"
                                variant={variant}
                                color="inherit"
                                whitespace="nowrap"
                                className={styles.then}
                            >
                                then
                            </Text>
                        )}
                        <Hotkey hotkey={press} size={size} textVariant={textVariant} />
                    </Fragment>
                ))}
            </span>
        );
    }

    const content = children ?? (hotkey != null ? hotkeysToSymbols(hotkey).join(' ') : undefined);

    return (
        <AriaKeyboard {...props} ref={ref} data-hotkey="" data-size={size} className={cn(styles.hotkey, className)}>
            <Text as="span" variant={variant} color="inherit" whitespace="nowrap">
                {content}
            </Text>
        </AriaKeyboard>
    );
}

Hotkey.displayName = 'Hotkey';
