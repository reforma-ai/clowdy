import { Text } from '@clowdy/components/Text';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { CommandHotkey } from '../hotkeys/CommandHotkey';
import { tildePath } from '../shared/displayPath';
import { homeFolder } from '../shared/homeFolder';
import cardStyles from '../shared/SlidingCard.module.css';
import { placeCard } from '../shared/slidingCard';
import styles from './ProjectCard.module.css';
import { projectSwitchCommand } from './projectSwitch';

import type { Project } from '@clowdy/protocol';

/** A row of the project menu carries its project's id as `data-project-row`: the card finds the row it stands beside by it. */
const ROW = '[data-project-row]';

/** The popover of the menu, which the card stands beside. */
const FRAME = '[data-trigger="MenuTrigger"]';

/**
 * The row the card stands for while the menu is open: the one the pointer moved onto, or the one the keyboard is on, `null` before either and once the pointer is
 * away from the menu. It reads the pointer itself, as the plate under the rows does, and not a tooltip, which showed only now and then on these rows.
 */
export function useProjectRow(isOpen: boolean): HTMLElement | null {
    const [row, setRow] = useState<HTMLElement | null>(null);

    useEffect(() => {
        if (!isOpen) return;

        let frame = 0;
        let x = Number.NaN;
        let y = Number.NaN;

        const onPointerMove = (event: PointerEvent) => {
            // The browser repeats the pointer's position as the layout changes under it; only a pointer that moved takes the card back from the keyboard.
            if (event.clientX === x && event.clientY === y) return;

            x = event.clientX;
            y = event.clientY;

            const target = event.target instanceof Element ? event.target : null;
            const next = target?.closest<HTMLElement>(ROW);

            // Between two rows, or on the popover's padding, the card stays where it was.
            if (next) setRow(next);
            else if (!target?.closest(FRAME)) setRow(null);
        };

        // Moving the focus with the pointer draws no focus ring (`data-focus-visible`), so only the keys put the card on a row.
        const onFocusIn = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const next = document.querySelector<HTMLElement>(`${ROW}[data-focus-visible]`);

                if (next) setRow(next);
            });
        };

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('focusin', onFocusIn);

        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('focusin', onFocusIn);
            setRow(null);
        };
    }, [isOpen]);

    return row;
}

/**
 * The card beside the menu, level with the row the pointer or the keyboard is on: the project's name and the keys that open it, and every folder it has in full, the
 * main one first (the row itself has the name and nothing else). One card for the whole menu, as the rail of messages has: it stays when the row changes and slides
 * to it.
 */
export function ProjectCard({ project, slot, row }: { project: Project; slot: number | undefined; row: HTMLElement }) {
    const cardRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const card = cardRef.current;
        const frame = row.closest<HTMLElement>(FRAME);

        if (card && frame) placeCard(card, frame, row, 'right', true);
    }, [row, project]);

    // A menu with many projects scrolls, and the row goes with it.
    useEffect(() => {
        const follow = () => {
            const card = cardRef.current;
            const frame = row.closest<HTMLElement>(FRAME);

            if (card && frame) placeCard(card, frame, row, 'right', false);
        };

        document.addEventListener('scroll', follow, true);

        return () => document.removeEventListener('scroll', follow, true);
    }, [row]);

    return createPortal(
        <div ref={cardRef} className={cardStyles.card} data-project-card="" aria-hidden="true">
            <div className={styles.head}>
                <Text as="p" variant="sm" weight="medium" className={styles.name}>
                    {project.name}
                </Text>
                {slot !== undefined && <CommandHotkey id={projectSwitchCommand(slot)} />}
            </div>
            <ul className={styles.folders}>
                {project.folders.map(folder => (
                    <li key={folder.id}>
                        <Text variant="sm" color="secondary">
                            {tildePath(folder.path, homeFolder.path)}
                        </Text>
                    </li>
                ))}
            </ul>
        </div>,
        document.body
    );
}
