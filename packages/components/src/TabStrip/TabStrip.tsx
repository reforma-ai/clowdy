import { Close } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { useEffect, useRef } from 'react';

import { Button } from '../Button';
import { Scrollable } from '../Scrollable';
import { Text } from '../Text';
import styles from './TabStrip.module.css';

import type { ReactNode } from 'react';

export interface TabStripProps {
    /** Names the tab list for assistive technology. */
    'aria-label'?: string;
    className?: string;
    /** The `Tab`s. */
    children: ReactNode;
    /** What sits after the tabs and stays in view while they scroll: a view switch, a button that adds a tab. */
    end?: ReactNode;
}

/**
 * A row of tabs over a body, as the file manager's editor has it and the side panel's terminals do: 40px tall with the panel header beside it, a rule under it,
 * the tabs scrolling sideways with faded edges, and `end` kept at the right.
 */
export function TabStrip({ children, end, className, 'aria-label': label }: TabStripProps) {
    return (
        <div className={ cn(styles.bar, className) }>
            <Scrollable vertical={ false } horizontal edgeFade className={ styles.strip } contentClass={ styles.list } role="tablist" aria-label={ label }>
                { children }
            </Scrollable>
            { end }
        </div>
    );
}

export interface TabProps {
    label: string;
    /** Before the label, 14px. */
    icon?: ReactNode;
    active?: boolean;
    /** Unsaved changes: a dot takes the place of the close button until the pointer is over the tab. */
    dirty?: boolean;
    /** What the tab shows is gone: the label is struck through. */
    deleted?: boolean;
    /** Names the close button, as `Close name.txt`. */
    closeLabel: string;
    className?: string;
    onSelect: () => void;
    /** From the close button and from a click with the middle button anywhere on the tab. */
    onClose: () => void;
}

/** One tab of a `TabStrip`: the whole of it up to the close button selects it, and an opened or chosen one scrolls into view. */
export function Tab({ label, icon, active, dirty, deleted, closeLabel, className, onSelect, onClose }: TabProps) {
    const tab = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (active) {
            tab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }, [active]);

    return (
        <div
            ref={ tab }
            className={ cn(styles.tab, className) }
            data-active={ active || undefined }
            data-dirty={ dirty || undefined }
            data-deleted={ deleted || undefined }
            onMouseDown={ (event) => {
                // Middle click closes instead of starting autoscroll.
                if (event.button === 1) {
                    event.preventDefault();
                }
            } }
            onAuxClick={ (event) => {
                if (event.button === 1) {
                    onClose();
                }
            } }
        >
            <button type="button" role="tab" aria-selected={ Boolean(active) } className={ styles.name } onClick={ onSelect }>
                { icon }
                <Text truncate>{ label }</Text>
            </button>
            <Button variant="filling" color="secondary" size="xs" iconOnly className={ styles.close } aria-label={ closeLabel } onPress={ onClose }>
                <Close className={ styles.closeIcon } />
                <span className={ styles.dirtyDot } />
            </Button>
        </div>
    );
}
