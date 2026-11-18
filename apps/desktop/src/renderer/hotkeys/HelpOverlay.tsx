import { ListBox, ListBoxHeader, ListBoxItem, ListBoxSection } from '@clowdy/components/List';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { Fragment } from 'react';

import { PressesHotkey } from './CommandHotkey';
import { groupHelpEntries, helpEntries, type HelpEntry } from './helpEntries';
import styles from './HelpOverlay.module.css';
import { hotkeys, type HotkeyRegistry } from './registry';

/**
 * Every command of the registry, in groups, with its keys. The rows only inform, so they select nothing and do nothing when pressed,
 * but the list is a real listbox: it takes the focus on open, and the arrow, Home, End and page keys move through it.
 * It lives in a `Modal` (see `openHelp`), a separate React root with no context, so it reads the registry directly.
 */
export function HelpOverlay({ registry = hotkeys }: { registry?: HotkeyRegistry }) {
    const groups = groupHelpEntries(helpEntries(registry));

    return (
        <div className={ styles.help }>
            <Text variant="heading-3" className={ styles.title }>Keyboard shortcuts</Text>

            <Scrollable className={ styles.scroll } contentClass={ styles.content } edgeFade>
                <ListBox aria-label="Keyboard shortcuts" size="md" selectionMode="none" className={ styles.list } autoFocus>
                    { groups.map(group => (
                        <ListBoxSection key={ group.name } id={ group.name }>
                            <ListBoxHeader>{ group.name }</ListBoxHeader>
                            { group.entries.map(entry => <ShortcutRow key={ entry.command.id } entry={ entry } />) }
                        </ListBoxSection>
                    )) }
                </ListBox>
            </Scrollable>
        </div>
    );
}

function ShortcutRow({ entry: { command, sequences } }: { entry: HelpEntry }) {
    return (
        <ListBoxItem id={ command.id } className={ styles.row } endAffix={ <Keys sequences={ sequences } /> }>
            { command.title }
        </ListBoxItem>
    );
}

/** The ways to type a command, side by side. They share one box so the list's end slot treats them as a unit and the capsules keep their square size. */
function Keys({ sequences }: { sequences: HelpEntry['sequences'] }) {
    return (
        <span className={ styles.keys }>
            { sequences.map((presses, index) => (
                // The alternatives of a command keep their order, so the position is their identity.
                <Fragment key={ index }>
                    { index > 0 && <Text variant="xs" color="secondary">or</Text> }
                    <PressesHotkey presses={ presses } />
                </Fragment>
            )) }
        </span>
    );
}
