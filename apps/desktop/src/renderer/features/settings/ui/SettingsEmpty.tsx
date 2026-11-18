import { Text } from '@clowdy/components/Text';

import styles from './SettingsEmpty.module.css';

import type { ReactNode } from 'react';

/** What a section shows when it has nothing: a dashed box and one line on what is missing and what to do. */
export function SettingsEmpty({ children }: { children: ReactNode }) {
    return <Text variant="sm" color="secondary" className={ styles.empty }>{ children }</Text>;
}
