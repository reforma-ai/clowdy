import { cn } from '@clowdy/lib';

import { useModalTitleId } from '../Modal';
import { Show } from '../Show';
import { Text } from '../Text';
import styles from './DialogLayout.module.css';

import type { FormEvent, ReactNode } from 'react';

export interface DialogLayoutProps {
    /** The dialog's heading, which also names it for a screen reader. */
    title: ReactNode;
    /** A line under the title on what the dialog does. */
    description?: ReactNode;
    children?: ReactNode;
    /** The buttons at the end of the bottom row: Cancel, then the primary action. */
    actions?: ReactNode;
    /** Makes the body a `form`, so Enter in a field submits; the handler gets the event with its default already prevented. */
    onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
    className?: string;
}

/** The body of a dialog: a title (an `h2` that names the modal), an optional description, the content, and the actions row, with the dialog's padding and rhythm. */
export function DialogLayout({ title, description, children, actions, onSubmit, className }: DialogLayoutProps) {
    const titleId = useModalTitleId();
    const body = (
        <>
            <div className={styles.header}>
                <Text as="h2" variant="heading-3" id={titleId} wrap="anywhere" className={styles.title}>
                    {title}
                </Text>
                <Show when={description}>
                    <Text variant="md" color="secondary">
                        {description}
                    </Text>
                </Show>
            </div>
            {children}
            <Show when={actions}>
                <div className={styles.actions}>{actions}</div>
            </Show>
        </>
    );

    return onSubmit ? (
        <form
            className={cn(styles.layout, className)}
            noValidate
            onSubmit={event => {
                event.preventDefault();
                onSubmit(event);
            }}
        >
            {body}
        </form>
    ) : (
        <div className={cn(styles.layout, className)}>{body}</div>
    );
}

DialogLayout.displayName = 'DialogLayout';
