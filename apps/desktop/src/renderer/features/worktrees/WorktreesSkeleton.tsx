import { ShimmerBlock } from '@clowdy/components/Shimmer';
import { Text } from '@clowdy/components/Text';

import styles from './ManageWorktrees.module.css';

/** The widths of the two rows' lines, which differ a little so the table does not look stamped. */
const ROWS = [
    { title: '9rem', facts: '6rem' },
    { title: '12rem', facts: '4.5rem' },
] as const;

/**
 * What the dialog shows while the first read of the worktrees is on its way: the table the list will be, with a folder's name and two rows of shimmering blocks in the places
 * of what a row has (the mark, a branch and its facts, the two buttons), made of the list's own styles so each line is as tall as the real one and nothing moves when the list
 * arrives. The blocks are hidden from a screen reader, which reads a status instead.
 */
export function WorktreesSkeleton() {
    return (
        <div className={ styles.group } aria-busy="true">
            <span className={ styles.visuallyHidden } role="status">Loading worktrees…</span>
            <Text as="h3" variant="heading-5" aria-hidden="true">
                <ShimmerBlock className={ styles.skeletonName } />
            </Text>
            <ul className={ styles.card } aria-hidden="true" data-skeleton="">
                { ROWS.map(({ title, facts }) => (
                    <li key={ title } className={ styles.row }>
                        <span className={ styles.icon }>
                            <ShimmerBlock className={ styles.skeletonIcon } />
                        </span>
                        <span className={ styles.text }>
                            <span className={ styles.title }>
                                <ShimmerBlock className={ styles.skeletonLine } style={ { width: title } } />
                            </span>
                            <span className={ styles.facts }>
                                <ShimmerBlock className={ styles.skeletonLine } style={ { width: facts } } />
                            </span>
                        </span>
                        <span className={ styles.actions }>
                            <ShimmerBlock className={ styles.skeletonButton } />
                            <ShimmerBlock className={ styles.skeletonButton } />
                        </span>
                    </li>
                )) }
            </ul>
        </div>
    );
}
