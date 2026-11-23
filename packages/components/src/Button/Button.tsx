import { cn, mergeRefs } from '@clowdy/lib';
import { type ReactNode, type Ref, useEffect, useRef } from 'react';
import {
    composeRenderProps,
    Button as RACButton,
    type ButtonProps as RACButtonProps,
    Link as RACLink,
    type LinkProps as RACLinkProps,
} from 'react-aria-components';

import { Show } from '../Show';
import { useSlotContextProps } from '../Slot';
import { Spinner } from '../Spinner';
import { Tooltip } from '../Tooltip';
import styles from './Button.module.css';

import type { SemanticColor } from '../types';

export type ButtonVariant = 'filled' | 'filling' | 'ghost' | 'bordered' | 'transparent' | 'inline';
export type ButtonColor = SemanticColor | 'contrast' | 'inherit';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'unset';

export interface ButtonProps extends RACButtonProps {
    ref?: Ref<HTMLButtonElement | HTMLAnchorElement | null>;
    variant?: ButtonVariant;
    color?: ButtonColor;
    size?: ButtonSize;
    rounded?: boolean;
    iconOnly?: boolean;
    fullWidth?: boolean;
    className?: string;
    truncate?: boolean;
    contentClassName?: string;
    href?: string;
    target?: '_blank' | '_self' | '_parent' | '_top';
    rel?: string;
    children?: ReactNode;
    tooltip?: string | ReactNode;
    tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
    /** Extra px between the tooltip and the button, past the default gap. */
    tooltipOffset?: number;
    isPressed?: boolean;
    tabIndex?: number;
    /** Where the pending spinner goes: over the hidden label, before the label it keeps, or nowhere (the label stays as it is and the caller animates it). */
    spinnerPlacement?: 'center' | 'start' | 'none';
}

export function Button(props: ButtonProps) {
    // SlotContext first; local props win; defaults after merge so context size/variant apply.
    const merged = useSlotContextProps(props);
    const {
        variant = 'filled',
        color,
        size = 'md',
        rounded = false,
        iconOnly = false,
        fullWidth = false,
        contentClassName,
        children,
        href,
        tooltip,
        tooltipPlacement,
        tooltipOffset,
        isPressed,
        truncate,
        tabIndex,
        spinnerPlacement = 'center',
        ref,
        className,
        autoFocus,
        ...restProps
    } = merged;
    /** Only forward user-provided string slot to the DOM; RAC's internal Symbol slot breaks React 19. */
    const domSlot = typeof props.slot === 'string' ? props.slot : undefined;

    const localRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
    const buttonRef = mergeRefs(localRef, ref);

    // Delay past Modal.open() → focus() so overlay does not steal focus after mount.
    useEffect(() => {
        if (!autoFocus) {
            return;
        }

        const timer = setTimeout(() => {
            localRef.current?.focus();
        }, 50);

        return () => clearTimeout(timer);
    }, [autoFocus]);

    const resolvedColor = color ?? (['inline', 'transparent'].includes(variant) ? 'inherit' : 'secondary');
    const buttonClassName = cn(styles.button, className, { 'w-full': fullWidth });
    const buttonDataAttrs = {
        'data-variant': variant,
        'data-color': resolvedColor,
        'data-size': size,
        'data-rounded': rounded || undefined,
        'data-icon-only': iconOnly || undefined,
        'data-truncate': truncate || undefined,
        'data-full-width': fullWidth || undefined,
    } as const;

    const content = composeRenderProps(children, (children: ReactNode, { isPending }: { isPending?: boolean }) =>
        spinnerPlacement === 'start' ? (
            <span className={cn(styles.content, contentClassName)}>
                <Show when={isPending}>
                    <Spinner size="inherit" className={styles.startSpinner} aria-hidden="true" />
                </Show>
                {children}
            </span>
        ) : (
            <>
                <span
                    className={cn(styles.content, contentClassName)}
                    data-hidden={(isPending && spinnerPlacement === 'center') || undefined}
                >
                    {children}
                </span>

                <Show when={isPending && spinnerPlacement === 'center'}>
                    <Spinner size="inherit" className={styles.spinner} aria-hidden="true" />
                </Show>
            </>
        )
    );

    if (href) {
        const link = (
            <RACLink
                {...(restProps as RACLinkProps)}
                slot={domSlot}
                ref={buttonRef as Ref<HTMLAnchorElement>}
                href={href}
                className={buttonClassName}
                {...buttonDataAttrs}
            >
                {children}
            </RACLink>
        );

        return tooltip != null ? (
            <Tooltip content={tooltip} placement={tooltipPlacement} offset={tooltipOffset}>
                {link}
            </Tooltip>
        ) : (
            link
        );
    }

    // Controlled isPressed = toggle/open visual; inherit aria-pressed unless caller overrides.
    const buttonStateProps =
        isPressed == null
            ? restProps
            : {
                  ...restProps,
                  isPressed,
                  'aria-pressed': restProps['aria-pressed'] ?? isPressed,
              };

    const racButton = (
        <RACButton
            {...buttonStateProps}
            slot={domSlot}
            ref={buttonRef as Ref<HTMLButtonElement>}
            className={buttonClassName}
            excludeFromTabOrder={tabIndex === -1 || buttonStateProps.excludeFromTabOrder}
            {...buttonDataAttrs}
        >
            {content}
        </RACButton>
    );

    return tooltip != null ? (
        <Tooltip content={tooltip} placement={tooltipPlacement} offset={tooltipOffset}>
            {racButton}
        </Tooltip>
    ) : (
        racButton
    );
}

Button.displayName = 'Button';
