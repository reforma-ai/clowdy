import { cn } from '@clowdy/lib';
import { createElement } from 'react';

import { useSlotContextProps } from '../Slot';

import type { ComponentPropsWithoutRef, ComponentPropsWithRef, ElementType } from 'react';
import type { SlotProps } from 'react-aria-components';
import type { Align, Direction, Justify, Spacing, Wrap } from '../types.ts';

const GAP_CLASS: Record<Spacing, string> = {
    xxs: 'gap-xxs',
    xs: 'gap-xs',
    sm: 'gap-sm',
    md: 'gap-md',
    lg: 'gap-lg',
    xl: 'gap-xl',
    xxl: 'gap-xxl',
};

type PaddingValue = Spacing | '0' | '10' | '20' | '36';
const PX_CLASS: Record<PaddingValue, string> = {
    0: 'px-0',
    10: 'px-10',
    20: 'px-20',
    36: 'px-36',
    xxs: 'px-xxs',
    xs: 'px-xs',
    sm: 'px-sm',
    md: 'px-md',
    lg: 'px-lg',
    xl: 'px-xl',
    xxl: 'px-xxl',
};
const PY_CLASS: Record<PaddingValue, string> = {
    0: 'py-0',
    10: 'py-10',
    20: 'py-20',
    36: 'py-36',
    xxs: 'py-xxs',
    xs: 'py-xs',
    sm: 'py-sm',
    md: 'py-md',
    lg: 'py-lg',
    xl: 'py-xl',
    xxl: 'py-xxl',
};

const DIRECTION_CLASS: Record<Direction, string> = {
    row: 'flex-row',
    'row-reverse': 'flex-row-reverse',
    column: 'flex-col',
    'column-reverse': 'flex-col-reverse',
};

const ALIGN_CLASS: Record<Align, string> = {
    start: 'items-start',
    center: 'items-center',
    end: 'items-end',
    stretch: 'items-stretch',
    baseline: 'items-baseline',
};

const JUSTIFY_CLASS: Record<Justify, string> = {
    start: 'justify-start',
    center: 'justify-center',
    end: 'justify-end',
    between: 'justify-between',
    around: 'justify-around',
    evenly: 'justify-evenly',
};

const WRAP_CLASS: Record<Wrap, string> = {
    nowrap: 'flex-nowrap',
    wrap: 'flex-wrap',
    'wrap-reverse': 'flex-wrap-reverse',
};

function wrapClassName(wrap: Wrap | boolean | undefined): string | undefined {
    if (wrap == null) {
        return undefined;
    }

    if (wrap === true) {
        return WRAP_CLASS.wrap;
    }

    if (wrap === false) {
        return WRAP_CLASS.nowrap;
    }

    return WRAP_CLASS[wrap];
}

/** Layout-only props; merged with intrinsic props for {@link BoxProps}[`as`]. */
export type BoxOwnProps = {
    padding?: PaddingValue;
    paddingX?: PaddingValue;
    paddingY?: PaddingValue;
    direction?: Direction;
    align?: Align;
    justify?: Justify;
    wrap?: Wrap | boolean;
    gap?: Spacing;
    fullWidth?: boolean;
    fullHeight?: boolean;
    grow?: boolean;
    equalWidth?: boolean;
};

export type BoxProps<E extends ElementType = 'div'> = BoxOwnProps &
    Omit<ComponentPropsWithRef<E>, keyof BoxOwnProps> & {
        as?: E;
    };

type BoxHtmlProps<E extends ElementType> = Omit<ComponentPropsWithoutRef<E>, keyof BoxOwnProps | 'as'>;

export function Box<E extends ElementType = 'div'>({
    as,
    padding,
    paddingX,
    paddingY,
    direction = 'column',
    align,
    justify,
    wrap,
    gap,
    children,
    fullWidth = false,
    fullHeight = false,
    grow = false,
    equalWidth = false,
    ...rest
}: BoxProps<E>) {
    const mergedProps = useSlotContextProps(rest as BoxHtmlProps<E> & SlotProps);
    const {
        className: mergedClassName,
        ref,
        children: _slotChildren,
        isDisabled,
        isInvalid,
        ...elementProps
    } = mergedProps as Omit<BoxHtmlProps<E>, 'slot'> & {
        isDisabled?: boolean;
        isInvalid?: boolean;
    };

    /** Forward HTML `slot` only when a string; RAC’s internal Symbol slot breaks React 19. */
    const slotProp = typeof rest.slot === 'string' ? { slot: rest.slot } : {};

    const Component = as ?? 'div';
    const normalizedPaddingX: PaddingValue | undefined = paddingX ?? padding;
    const normalizedPaddingY: PaddingValue | undefined = paddingY ?? padding;
    align = align ?? (direction === 'column' ? undefined : 'center');

    return createElement(
        Component,
        {
            ref,
            'data-disabled': isDisabled || undefined,
            'data-invalid': isInvalid || undefined,
            ...elementProps,
            ...slotProp,
            className: cn(
                'flex',
                DIRECTION_CLASS[direction],
                wrapClassName(wrap),
                align && ALIGN_CLASS[align],
                justify && JUSTIFY_CLASS[justify],
                gap && GAP_CLASS[gap],
                normalizedPaddingX && PX_CLASS[normalizedPaddingX],
                normalizedPaddingY && PY_CLASS[normalizedPaddingY],
                fullWidth && 'w-full max-w-full',
                fullHeight && 'h-full max-h-full',
                grow && 'min-h-0 min-w-0 flex-1',
                equalWidth && '[&>*]:flex-1 [&>*]:min-w-0',
                mergedClassName
            ),
        },
        children
    );
}

Box.displayName = 'Box';
