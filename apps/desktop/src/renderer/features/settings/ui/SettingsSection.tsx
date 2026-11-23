import { Text } from '@clowdy/components/Text';

import styles from './SettingsSection.module.css';

import type { ReactNode } from 'react';

export interface SettingsSectionProps {
    title: string;
    /** A small count or tag after the title. */
    aside?: ReactNode;
    /** What the group is, under the heading. */
    description?: ReactNode;
    /** Usually a `SettingsCard`. */
    children?: ReactNode;
}

/** A group of settings: a heading, a line on what it is, and the card that holds them. */
export function SettingsSection({ title, aside, description, children }: SettingsSectionProps) {
    return (
        <section className={styles.section} aria-label={title}>
            <div className={styles.heading}>
                <Text as="h2" variant="heading-5" className={styles.title}>
                    {title}
                </Text>
                {aside}
            </div>
            {description && (
                <Text variant="sm" color="secondary">
                    {description}
                </Text>
            )}
            {children}
        </section>
    );
}
