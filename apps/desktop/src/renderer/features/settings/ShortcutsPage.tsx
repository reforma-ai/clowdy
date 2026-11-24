import { Text } from '@clowdy/components/Text';
import { Fragment, useMemo } from 'react';

import { PressesHotkey } from '../../hotkeys';
import { groupHelpEntries, type HelpEntry } from '../../hotkeys/helpEntries';
import { shortcutEntries } from '../../shell/keymap';
import { panelOrder } from '../sidePanel/panelOrder';
import styles from './ShortcutsPage.module.css';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

/**
 * Settings > Shortcuts: every command of the app with its keys, in a card for each group. It only informs: there is nothing to change, and a row does nothing when pressed.
 * `?` opens Settings here. The list is the whole keymap (`shortcutEntries`), not the registry, which holds only the commands of the section that is mounted, and Settings takes its place.
 */
export function ShortcutsPage() {
    const order = panelOrder.order.join(',');
    const groups = useMemo(() => groupHelpEntries(shortcutEntries()), [order]);

    return (
        <SettingsPage description="The keys that run commands in Clowdy">
            {groups.map(group => (
                <SettingsSection key={group.name} title={group.name}>
                    <SettingsCard divided>
                        {group.entries.map(({ command, sequences }) => (
                            <SettingsRow key={command.id} title={command.title}>
                                <Keys sequences={sequences} />
                            </SettingsRow>
                        ))}
                    </SettingsCard>
                </SettingsSection>
            ))}
        </SettingsPage>
    );
}

/** The ways to type a command, side by side in one box, so the capsules keep their square size. */
function Keys({ sequences }: { sequences: HelpEntry['sequences'] }) {
    return (
        <span className={styles.keys}>
            {sequences.map((presses, index) => (
                // The alternatives of a command keep their order, so the position is their identity.
                <Fragment key={index}>
                    {index > 0 && (
                        <Text variant="xs" color="secondary">
                            or
                        </Text>
                    )}
                    <PressesHotkey presses={presses} />
                </Fragment>
            ))}
        </span>
    );
}
