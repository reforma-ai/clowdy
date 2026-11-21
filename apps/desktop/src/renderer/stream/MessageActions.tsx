import { Button } from '@clowdy/components/Button';
import { CopyButton } from '@clowdy/components/CopyButton';
import { Show } from '@clowdy/components/Show';
import { Revert } from '@clowdy/icons/14';

import { formatFullTime, formatMessageTime } from '../shared/time';
import styles from './MessageActions.module.css';

/** When a row shows: while the pointer or the focus is on its message, or all the time (the last message that has a row). Where the pointer cannot hover, it always shows. */
export type MessageActionsShow = 'hover' | 'always';

/**
 * What the row under a message offers besides the time. Copy is always there; an action that needs a handler is drawn only when it has one, so a
 * page that can do nothing with a message shows no button for it. Later actions are added here as handlers.
 */
export interface MessageActionsConfig {
    show: MessageActionsShow;
    /** Reply: called with the message as it was written, to quote it in the message box. */
    onReply?: (text: string) => void;
}

export interface MessageActionsProps {
    /** The message as it was written, Markdown included: what Copy puts on the clipboard and Reply quotes. */
    text: string;
    /** When the message was written. */
    at: number;
    /** The side of the stream the message is on: the person's on the right, an agent's on the left. */
    align: 'start' | 'end';
    actions: MessageActionsConfig;
}

/**
 * The row under a message: what can be done with it and when it was written. The buttons are in the order they are read and tabbed in, and the time
 * sits on the outside: first on the person's side (`22:54`, Copy, Reply), last on an agent's (Copy, Reply, `22:54`). It keeps its height whether it shows
 * or not, so showing it never moves the messages around it. Put it as the last child of the element that holds the message: that element is what the
 * pointer or the focus has to be on (see the stylesheet).
 */
export function MessageActions({ text, at, align, actions }: MessageActionsProps) {
    const { show, onReply } = actions;
    const time = <time className={ styles.time } dateTime={ new Date(at).toISOString() } title={ formatFullTime(at) }>{ formatMessageTime(at) }</time>;
    const hasText = text.trim() !== '';

    return (
        <div className={ styles.row } data-align={ align } data-show={ show }>
            { align === 'end' && time }
            { /* A message of files alone has nothing to copy or quote, so no group: its empty box would still move the time. */ }
            <Show when={ hasText }>
                <div className={ styles.buttons }>
                    <CopyButton value={ text } variant="filling" size="xs" tooltip="Copy message" tooltipPlacement="bottom" aria-label="Copy message" />
                    <Show when={ onReply }>
                        { reply => (
                            <Button variant="filling" size="xs" iconOnly tooltip="Reply" tooltipPlacement="bottom" aria-label="Reply" onPress={ () => reply(text) }>
                                <Revert />
                            </Button>
                        ) }
                    </Show>
                </div>
            </Show>
            { align === 'start' && time }
        </div>
    );
}
