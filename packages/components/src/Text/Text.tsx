import { cn } from '@clowdy/lib';
import { createElement, type ComponentPropsWithoutRef, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { TextContext } from 'react-aria-components';

import { useSlotContextProps } from '../Slot';
import styles from './Text.module.css';

import type { TextColor, TextVariant } from '../types';

export type { TextColor, TextVariant };

const COLOR_CLASS: Record<Exclude<TextColor, 'inherit'>, string> = {
    default: 'color-text',
    secondary: 'color-secondary-muted-text',
    primary: 'color-primary-text',
    accent: 'color-accent-text',
    danger: 'color-danger-text',
    warning: 'color-warning-text',
    success: 'color-success-text',
};

export type TextTransform = 'uppercase' | 'lowercase' | 'capitalize' | 'none';
const TRANSFORM_CLASS: Record<TextTransform, string> = {
    uppercase: 'case-upper',
    lowercase: 'case-lower',
    capitalize: 'case-capital',
    none: 'case-normal',
};

export type TextSelect = 'none' | 'text' | 'all';
const SELECT_CLASS: Record<TextSelect, string> = {
    none: 'select-none',
    text: 'select-text',
    all: 'select-all',
};

export type TextAlign = 'start' | 'center' | 'end' | 'justify';
const ALIGN_CLASS: Record<TextAlign, string> = {
    start: 'text-start',
    center: 'text-center',
    end: 'text-end',
    justify: 'text-justify',
};

export type TextWrap = 'normal' | 'words' | 'all' | 'keep' | 'anywhere';
const WRAP_CLASS: Record<TextWrap, string> = {
    normal: 'break-normal',
    words: 'break-words',
    all: 'break-all',
    keep: 'break-keep',
    anywhere: 'break-anywhere',
};

export type TextWhitespace = 'normal' | 'nowrap' | 'pre' | 'pre-line' | 'pre-wrap' | 'break-spaces';
const WHITESPACE_CLASS: Record<TextWhitespace, string> = {
    normal: 'whitespace-normal',
    nowrap: 'whitespace-nowrap',
    pre: 'whitespace-pre',
    'pre-line': 'whitespace-pre-line',
    'pre-wrap': 'whitespace-pre-wrap',
    'break-spaces': 'whitespace-break-spaces',
};

export type TextDecoration = 'underline' | 'line-through' | 'overline';
const DECORATION_CLASS: Record<TextDecoration, string> = {
    underline: 'underline',
    'line-through': 'line-through',
    overline: 'overline',
};

/** Named weights map to Tailwind font utilities. When set, overrides {@link TextProps.bold}. */
export type TextWeightNamed = 'normal' | 'medium' | 'semibold' | 'bold';
export type TextWeightNumericString = '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '950';
export type TextWeightNumeric = | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950 | TextWeightNumericString;
export type TextWeight = TextWeightNamed | TextWeightNumeric;

/**
 * Tailwind `font-*` utilities for every {@link TextWeight}.
 * Numeric keys follow Tailwind defaults; `950` uses `font-[950]` (no theme alias).
 */
const WEIGHT_CLASS = {
    normal: 'font-normal',
    medium: 'font-medium',
    semibold: 'font-semibold',
    bold: 'font-bold',
    100: 'font-thin',
    200: 'font-extralight',
    300: 'font-light',
    400: 'font-normal',
    500: 'font-medium',
    600: 'font-semibold',
    700: 'font-bold',
    800: 'font-extrabold',
    900: 'font-black',
    950: 'font-[950]',
} as const satisfies Record<TextWeightNamed | Exclude<TextWeightNumeric, TextWeightNumericString>, string>;

const NAMED_WEIGHT_SET = new Set<TextWeightNamed>(['normal', 'medium', 'semibold', 'bold']);

function weightLookupKey(weight: TextWeight): keyof typeof WEIGHT_CLASS {
    if (typeof weight === 'string' && !NAMED_WEIGHT_SET.has(weight as TextWeightNamed)) {
        return Number(weight) as keyof typeof WEIGHT_CLASS;
    }

    return weight as keyof typeof WEIGHT_CLASS;
}

function weightClass(weight: TextWeight): string {
    return WEIGHT_CLASS[weightLookupKey(weight)];
}

/** Supported `as` tags — props follow the chosen element. */
export type TextElement
    = | 'a'
      | 'b'
      | 'blockquote'
      | 'button'
      | 'caption'
      | 'code'
      | 'dd'
      | 'div'
      | 'dt'
      | 'em'
      | 'figcaption'
      | 'h1'
      | 'h2'
      | 'h3'
      | 'h4'
      | 'h5'
      | 'h6'
      | 'i'
      | 'kbd'
      | 'label'
      | 'legend'
      | 'li'
      | 'mark'
      | 'p'
      | 'pre'
      | 'samp'
      | 'small'
      | 'span'
      | 'strong'
      | 'sub'
      | 'sup'
      | 'time';

type TextOwnProps = {
    variant?: TextVariant;
    color?: TextColor;
    truncate?: boolean;
    italic?: boolean;
    /** When `weight` is omitted: applies **bold** (700) when true. */
    bold?: boolean;
    /** Explicit weight (named or 100–900 / 950); when set, **`bold` is ignored** for font-weight. */
    weight?: TextWeight;
    decoration?: TextDecoration;
    transform?: TextTransform;
    select?: TextSelect;
    align?: TextAlign;
    wrap?: TextWrap;
    whitespace?: TextWhitespace;
    className?: string;
    children?: ReactNode;
};

export type TextProps<E extends TextElement = 'span'> = TextOwnProps & {
    as?: E;
    ref?: Ref<HTMLElementTagNameMap[E]>;
} & Omit<ComponentPropsWithoutRef<E>, keyof TextOwnProps | 'color'>;

export { TextContext };

export function Text<E extends TextElement = 'span'>({
    as: Component = 'span' as E,
    variant,
    color,
    truncate,
    italic,
    bold,
    weight,
    decoration,
    transform,
    select,
    align,
    wrap,
    whitespace,
    children,
    ...props
}: TextProps<E>) {
    // If props.slot is defined, useSlotContextProps will merge appropriate props passed from SlotContext
    // for the given slot
    const mergedProps = useSlotContextProps(props);
    const domProps = { ...mergedProps } as typeof mergedProps & {
        isDisabled?: boolean;
        isInvalid?: boolean;
    };
    delete domProps.isDisabled;
    delete domProps.isInvalid;
    const { className: mergedClassName, ...restMerged } = domProps;
    /** Only forward user-provided string slot to the DOM; RAC's internal Symbol slot breaks React 19. */
    const slotProp = typeof props.slot === 'string' ? { slot: props.slot } : {};

    return createElement(
        Component,
        {
            ...restMerged,
            ...slotProp,
            className: cn(
                variant && styles[variant],
                truncate && 'truncate',
                italic && 'italic',
                weight && weightClass(weight),
                bold && 'font-bold',
                decoration && DECORATION_CLASS[decoration],
                transform && TRANSFORM_CLASS[transform],
                select && SELECT_CLASS[select],
                align && ALIGN_CLASS[align],
                wrap && WRAP_CLASS[wrap],
                whitespace && WHITESPACE_CLASS[whitespace],
                color && color !== 'inherit' && COLOR_CLASS[color],
                mergedClassName
            ),
            children,
        } as HTMLAttributes<HTMLElement>
    );
}

Text.displayName = 'Text';
