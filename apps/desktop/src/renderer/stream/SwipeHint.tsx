import { Revert } from '@clowdy/icons/14';

import styles from './SwipeHint.module.css';

/**
 * The Reply mark a message shows at the side it was pulled from, fading in as the pull nears the threshold (`useSwipeReply` sets `--swipe-progress` and
 * `data-swipe` on the message, which this sits in as an absolutely placed child). Nothing to read or press: the row's Reply button is the accessible way.
 */
export function SwipeHint() {
    return (
        <span className={ styles.hint } aria-hidden>
            <Revert />
        </span>
    );
}
