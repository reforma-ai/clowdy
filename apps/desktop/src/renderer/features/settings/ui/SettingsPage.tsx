import { SettingsLayout } from '@clowdy/components/SettingsLayout';

import styles from './SettingsPage.module.css';

import type { ReactNode } from 'react';

export interface SettingsPageProps {
    /** What the page is for, at its top under a hairline. */
    description?: ReactNode;
    children?: ReactNode;
}

/**
 * The body of a Settings page, as it scrolls in the Settings window (`SettingsLayout`, which draws the title, the path of nested pages and the page's action above
 * it): what the page is for and a hairline, then its blocks, which are `SettingsSection`s, 24px apart.
 */
export function SettingsPage({ description, children }: SettingsPageProps) {
    return (
        <div className={styles.body}>
            {description && <SettingsLayout.Intro>{description}</SettingsLayout.Intro>}
            {children}
        </div>
    );
}
