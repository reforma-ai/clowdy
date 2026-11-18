import { Text } from '@clowdy/components/Text';
import { cn } from '@clowdy/lib';

import { SettingsBlock } from './SettingsBlock';
import styles from './SettingsRow.module.css';

import type { ComponentPropsWithoutRef, ReactNode } from 'react';

export interface SettingsRowProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
    title: ReactNode;
    description?: ReactNode;
    /** The control, at the end of the row. */
    children?: ReactNode;
    /** The control goes under the text and takes the row's width. */
    stacked?: boolean;
    /** Full width under the row: a notice about it, an alert. */
    footer?: ReactNode;
}

/** One setting: what it is, with a line on what it does, and its control at the end, as in macOS and iOS settings. */
export function SettingsRow({ title, description, children, stacked = false, footer, className, ...props }: SettingsRowProps) {
    return (
        <SettingsBlock { ...props } className={ cn(styles.row, className) } data-stacked={ stacked || undefined }>
            <div className={ styles.text }>
                <Text variant="sm" bold>{ title }</Text>
                { description && <Text variant="sm" color="secondary">{ description }</Text> }
            </div>
            { children && <div className={ styles.control }>{ children }</div> }
            { footer && <div className={ styles.footer }>{ footer }</div> }
        </SettingsBlock>
    );
}
