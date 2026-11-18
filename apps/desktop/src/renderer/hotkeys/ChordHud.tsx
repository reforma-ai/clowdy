import { Hotkey } from '@clowdy/components/Hotkey';
import { Text } from '@clowdy/components/Text';

import styles from './ChordHud.module.css';
import { hotkeys, type HotkeyRegistry } from './registry';

/**
 * The keys typed so far of a chord and what each next key does, at the bottom of the window. Shows only while a chord waits for its key
 * (`registry.pending`), so it goes away when the chord completes, on Escape, and on the chord's timeout. `Shell` mounts it once.
 */
export function ChordHud({ registry = hotkeys }: { registry?: HotkeyRegistry }) {
    const { pending } = registry;

    if (!pending) return null;

    return (
        <div className={ styles.layer }>
            <div className={ styles.hud } role="status" aria-label="Shortcut in progress">
                <Hotkey sequence={ pending.typed } size="xs" className={ styles.typed } />
                <ul className={ styles.next }>
                    { pending.candidates.map(({ command, remaining }, index) => (
                        // The same command can continue in two ways, so its id alone is not unique.
                        <li key={ `${ command.id }:${ index }` } className={ styles.item }>
                            <Hotkey sequence={ remaining } size="xs" />
                            <Text variant="sm" color="secondary" whitespace="nowrap">{ command.title }</Text>
                        </li>
                    )) }
                </ul>
            </div>
        </div>
    );
}
