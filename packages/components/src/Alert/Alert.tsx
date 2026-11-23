import { cn } from '@clowdy/lib';
import { Children, type HTMLAttributes, isValidElement, type ReactNode } from 'react';

import { Text } from '../Text';
import styles from './Alert.module.css';

import type { SemanticColor } from '../types';

export type AlertColor = SemanticColor;

export type AlertProps = {
    /** Surface tint. `secondary` is the default plate. */
    color?: AlertColor;
    className?: string;
    children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'color'>;

export type AlertIconProps = HTMLAttributes<HTMLSpanElement>;
export type AlertTitleProps = Omit<HTMLAttributes<HTMLDivElement>, 'color'>;
export type AlertDescriptionProps = Omit<HTMLAttributes<HTMLDivElement>, 'color'>;
export type AlertActionProps = HTMLAttributes<HTMLDivElement>;

export function Alert({ color, className, role = 'alert', children, ...props }: AlertProps) {
    const tint = color === 'secondary' ? undefined : color;
    const { icon, body, action } = splitSlots(children);

    return (
        <div role={role} className={cn(styles.alert, className)} data-color={tint} {...props}>
            {icon}
            <div className={styles.body}>{body}</div>
            {action}
        </div>
    );
}

/** Decorative icon slot. Hidden from assistive tech — title carries the meaning. */
export function AlertIcon({ className, ...props }: AlertIconProps) {
    return <span aria-hidden className={cn(styles.icon, className)} {...props} />;
}

export function AlertTitle({ className, children, ...props }: AlertTitleProps) {
    return (
        <Text as="div" variant="heading-5" data-inline-links className={cn(styles.title, className)} {...props}>
            {children}
        </Text>
    );
}

export function AlertDescription({ className, children, ...props }: AlertDescriptionProps) {
    return (
        <Text as="div" variant="sm" data-inline-links className={cn(styles.description, className)} {...props}>
            {children}
        </Text>
    );
}

export function AlertAction({ className, ...props }: AlertActionProps) {
    return <div className={cn(styles.action, className)} {...props} />;
}

function splitSlots(children: ReactNode) {
    let icon: ReactNode;
    let action: ReactNode;
    const body: ReactNode[] = [];

    Children.forEach(children, child => {
        if (isValidElement(child) && child.type === AlertIcon) {
            icon = child;

            return;
        }

        if (isValidElement(child) && child.type === AlertAction) {
            action = child;

            return;
        }

        body.push(child);
    });

    return { icon, body, action };
}

Alert.displayName = 'Alert';
AlertIcon.displayName = 'AlertIcon';
AlertTitle.displayName = 'AlertTitle';
AlertDescription.displayName = 'AlertDescription';
AlertAction.displayName = 'AlertAction';
