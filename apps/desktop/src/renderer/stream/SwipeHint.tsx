import { Reply } from '@clowdy/icons/14';

import styles from './SwipeHint.module.css';

/**
 * The Reply mark a message shows on the right, the side a pull to the left opened up. It fades in as the pull nears the threshold and takes the accent once
 * letting go would reply (`useSwipeReply` sets `--swipe-progress`, `data-swipe` and `data-swipe-armed` on the message, which this sits in as an absolutely
 * placed child). Nothing to read or press: the row's Reply button is the accessible way.
 */
export function SwipeHint() {
    return (
        <span className={ styles.hint } aria-hidden>
            <Reply />
        </span>
    );
}
