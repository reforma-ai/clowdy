import { ChevronDown, ChevronRight } from '@clowdy/icons/8';

import { Show } from '../Show';
import styles from './Panel.module.css';

/** Open/closed chevron for a tree row. Place it in a positioned wrapper around the row icon; it hangs into the indent on the left. */
export function TreeChevron({ isOpen, onToggle }: { isOpen: boolean; onToggle: () => void }) {
    return (
        <span
            className={ styles.treeChevron }
            aria-hidden="true"
            onClick={ (e) => {
                e.stopPropagation();
                onToggle();
            } }
        >
            <Show when={ isOpen } fallback={ <ChevronRight /> }>
                <ChevronDown />
            </Show>
        </span>
    );
}
