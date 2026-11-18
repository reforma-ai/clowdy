import { SearchInput } from '@clowdy/components/Input';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { Fragment, useRef, useState, type KeyboardEvent } from 'react';

import { PressesHotkey } from './CommandHotkey';
import { filterHelpEntries, groupHelpEntries, helpEntries, type HelpEntry } from './helpEntries';
import styles from './HelpOverlay.module.css';
import { hotkeys, type HotkeyRegistry } from './registry';

/** How far a key scrolls the list, as a share of its height. */
const SCROLL_STEPS = new Map([['ArrowDown', 0.12], ['ArrowUp', -0.12], ['PageDown', 0.9], ['PageUp', -0.9]]);

/**
 * Every command of the registry, in groups, with its keys and a search over titles and keys. The ones that cannot run now are quieter.
 * It lives in a `Modal` (see `openHelp`), a separate React root with no context, so it reads the registry directly.
 */
export function HelpOverlay({ registry = hotkeys }: { registry?: HotkeyRegistry }) {
    const [query, setQuery] = useState('');
    const list = useRef<HTMLDivElement | null>(null);
    const entries = helpEntries(registry);
    const groups = groupHelpEntries(filterHelpEntries(entries, query));

    // The field keeps focus and a one-line field has no use for these keys, so they scroll the list for a person without a pointer.
    const scrollList = (event: KeyboardEvent<HTMLInputElement>) => {
        const step = SCROLL_STEPS.get(event.key);

        if (step === undefined || !list.current) return;

        event.preventDefault();
        list.current.scrollBy({ top: step * list.current.clientHeight });
    };

    return (
        <div className={ styles.help }>
            <Text variant="heading-3">Keyboard shortcuts</Text>

            <SearchInput aria-label="Search shortcuts" placeholder="Search by name or key" value={ query } onChange={ setQuery } onKeyDown={ scrollList } autoFocus />

            <Scrollable className={ styles.scroll } containerRef={ list } contentClass={ styles.groups }>
                { groups.map(group => (
                    <div key={ group.name } className={ styles.group }>
                        <Text as="h3" variant="label" color="secondary">{ group.name }</Text>
                        <ul className={ styles.rows }>
                            { group.entries.map(entry => <Row key={ entry.command.id } entry={ entry } />) }
                        </ul>
                    </div>
                )) }

                { groups.length === 0 && <Text variant="md" color="secondary" className={ styles.empty }>No shortcut matches “{ query.trim() }”</Text> }
            </Scrollable>

            { entries.some(entry => !entry.live) && <Text variant="label" color="secondary">Dimmed shortcuts are not available right now.</Text> }
        </div>
    );
}

function Row({ entry: { command, live, sequences } }: { entry: HelpEntry }) {
    return (
        <li className={ styles.row } data-live={ live }>
            <Text variant="md" className={ styles.title }>{ command.title }</Text>
            <span className={ styles.keys }>
                { sequences.map((presses, index) => (
                    // The alternatives of a command keep their order, so the position is their identity.
                    <Fragment key={ index }>
                        { index > 0 && <Text variant="label" color="secondary">or</Text> }
                        <PressesHotkey presses={ presses } size="sm" />
                    </Fragment>
                )) }
            </span>
        </li>
    );
}
