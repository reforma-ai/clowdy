import { CopyButton } from '@clowdy/components/CopyButton';
import { Show } from '@clowdy/components/Show';

import { formatFullTime, formatMessageTime } from '../shared/time';
import styles from './MessageActions.module.css';

/** When a row shows: while the pointer or the focus is on its message, or all the time (the last message that has a row). Where the pointer cannot hover, it always shows. */
export type MessageActionsShow = 'hover' | 'always';

export interface MessageActionsProps {
    /** The message as it was written, Markdown included: what Copy puts on the clipboard. */
    text: string;
    /** When the message was written. */
    at: number;
    /** The side of the stream the message is on: the person's on the right, an agent's on the left. */
    align: 'start' | 'end';
    show: MessageActionsShow;
}

/**
 * The row under a message: what can be done with it and when it was written. It keeps its height whether it shows or
 * not, so showing it never moves the messages around it. Put it as the last child of the element that holds the message: that
 * element is what the pointer or the focus has to be on (see the stylesheet).
 */
export function MessageActions({ text, at, align, show }: MessageActionsProps) {
    return (
        <div className={ styles.row } data-align={ align } data-show={ show }>
            <Show when={ text.trim() !== '' }>
                <CopyButton value={ text } className={ styles.copy } variant="filling" size="xs" tooltip="Copy message" tooltipPlacement="bottom" aria-label="Copy message" />
            </Show>
            <time className={ styles.time } dateTime={ new Date(at).toISOString() } title={ formatFullTime(at) }>{ formatMessageTime(at) }</time>
        </div>
    );
}
