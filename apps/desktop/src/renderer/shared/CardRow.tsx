import { cn } from '@clowdy/lib';

import styles from './CardRow.module.css';

import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/** `data-*` attributes, for a test or a list that finds the row's button by them. */
type DataAttributes = { [key: `data-${ string }`]: string | undefined };

export interface CardRowProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
    icon: ReactNode;
    title: ReactNode;
    /** Marks after the title: Main, Folder missing. */
    marks?: ReactNode;
    /** The lines under the title: a path, a remote, what it holds. */
    children?: ReactNode;
    /** Buttons at the end of the row, outside the part a press opens. */
    actions?: ReactNode;
    /** Makes the row, all but its actions, one button: a press anywhere on it opens what the row is. */
    onPress?: () => void;
    /** Attributes of that button. */
    pressProps?: DataAttributes;
}

/**
 * A row that is a card of its own, as the projects of Settings > Projects are: an icon in a box of its own,
 * the title with its marks and the lines under it, and the actions at the end.
 */
export function CardRow({ icon, title, marks, children, actions, onPress, pressProps, className, ...props }: CardRowProps) {
    const body = (
        <>
            <span className={ styles.icon }>{ icon }</span>
            <span className={ styles.text }>
                <span className={ styles.title }>{ title }{ marks }</span>
                { children }
            </span>
        </>
    );

    return (
        <div { ...props } className={ cn(styles.row, className) } data-actions={ actions ? '' : undefined }>
            { onPress
                ? <button type="button" { ...pressProps } className={ styles.body } onClick={ onPress }>{ body }</button>
                : <div className={ styles.body }>{ body }</div> }
            { actions && <span className={ styles.actions }>{ actions }</span> }
        </div>
    );
}
