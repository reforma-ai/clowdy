import { cn } from '@clowdy/lib';

import { CommandHotkey, commandHint } from '../../hotkeys';
import { Unavailable } from '../../shared/Unavailable';
import { SIDE_PANEL_COMMAND } from './commands';
import { PANEL_SIZE_LABELS, type PanelSizeOption } from './panelSize';
import styles from './SidePanelSizes.module.css';

import type { SidePanelSize } from '../../stores';

/**
 * The window drawn small, with the panel in the size the option is: the chats' list at the left, the rail at the right edge, and between them the chat's place, where the
 * panel takes all of it (wide), the right half of it with the chat's first lines in the other (half), or nothing, and the chat's lines across it (hide).
 */
function SizePreview({ size }: { size: SidePanelSize }) {
    return (
        <svg className={styles.preview} viewBox="0 0 64 40" width={60} height={37.5} aria-hidden="true">
            <rect className={styles.frame} x={0.5} y={0.5} width={63} height={39} rx={5.5} />
            <rect className={styles.chrome} x={4} y={4} width={11} height={32} rx={2.5} />
            <rect className={styles.chrome} x={57} y={4} width={3} height={32} rx={1.5} />
            {size === 'wide' && <rect className={styles.panel} x={18} y={4} width={36} height={32} rx={3} />}
            {size === 'half' && (
                <>
                    <rect className={styles.chrome} x={21} y={8} width={11} height={3} rx={1.5} />
                    <rect className={styles.chrome} x={21} y={14} width={7} height={3} rx={1.5} />
                    <rect className={styles.panel} x={36} y={4} width={18} height={32} rx={3} />
                </>
            )}
            {size === 'hide' && (
                <>
                    <rect className={styles.chrome} x={21} y={8} width={30} height={3} rx={1.5} />
                    <rect className={styles.chrome} x={21} y={14} width={20} height={3} rx={1.5} />
                    <rect className={styles.chrome} x={21} y={20} width={26} height={3} rx={1.5} />
                </>
            )}
        </svg>
    );
}

export interface SidePanelSizesProps {
    /** The size the panel is in now: its option is lit. */
    size: SidePanelSize;
    /** The options, in the order they are drawn: one that is `unavailable` is grey, says why under its name, and cannot be chosen. */
    options: readonly PanelSizeOption[];
    onSelect: (size: SidePanelSize) => void;
}

/**
 * The menu of the rail's corner button: a title that says what the pictures are for (the side panel), under it the key that opens and shuts the panel (left out while that
 * command has no key to show), and then the sizes in a row, each a picture of the window with the panel in that size and its name under it. The size the panel is in has the
 * focus when the menu opens, so the keys work in it at once. A size that cannot be chosen is grey, and a tooltip on it says why (`Unavailable`), where a caption under it would
 * have made its tile taller than the others.
 */
export function SidePanelSizes({ size, options, onSelect }: SidePanelSizesProps) {
    return (
        <div className={styles.menu}>
            <div className={styles.title}>Side panel</div>
            {commandHint(SIDE_PANEL_COMMAND) && (
                <div className={styles.hint}>
                    Use <CommandHotkey id={SIDE_PANEL_COMMAND} size="xs" /> to toggle the panel
                </div>
            )}
            <div className={styles.sizes} role="group" aria-label="Side panel size">
                {options.map(({ size: option, unavailable }) => (
                    <div key={option} className={styles.cell}>
                        <Unavailable label={PANEL_SIZE_LABELS[option]} hint={unavailable} placement="bottom">
                            <button
                                type="button"
                                className={cn(styles.option, option === size && styles.current)}
                                aria-pressed={option === size}
                                disabled={unavailable !== undefined}
                                autoFocus={option === size}
                                onClick={() => onSelect(option)}
                            >
                                <SizePreview size={option} />
                                <span className={styles.label}>{PANEL_SIZE_LABELS[option]}</span>
                            </button>
                        </Unavailable>
                    </div>
                ))}
            </div>
        </div>
    );
}
