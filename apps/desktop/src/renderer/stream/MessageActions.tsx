import { Button } from '@clowdy/components/Button';
import { CopyButton } from '@clowdy/components/CopyButton';
import { Show } from '@clowdy/components/Show';
// Fork wears the thread's mark until a Fork icon is drawn: swapping it is this one import.
import { EditPen, Split as ForkIcon, Reply } from '@clowdy/icons/14';

import { formatFullTime, formatMessageTime } from '../shared/time';
import styles from './MessageActions.module.css';

/** A whole message handed to Reply: who wrote it (the person, or the agent whose answer it is), and its source Markdown. */
export interface ReplyMessage {
    role: 'user' | 'assistant';
    text: string;
}

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
    /** A long swipe to the left over the message, let go, does what the Reply button does (`useSwipeReply`); a message that has no Reply button has no swipe either. */
    swipeToReply?: boolean;
    /** Edit the message in place: drawn only where it is given (`StreamView` gives it to a message of the person's that the agent can rewrite the chat from, and to none while one is being edited). */
    onEdit?: () => void;
    /** Fork into a new chat, at this message: drawn only where it is given (`StreamView` gives it to an answer the agent can fork at). */
    onFork?: () => void;
    /** A fork is being made: `pending` on the button that started it, `blocked` on the others, so there is one at a time. */
    forkState?: 'pending' | 'blocked';
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
 * sits on the outside: first on the person's side (`22:54`, Copy, Edit, Reply), last on an agent's (Copy, Reply, Fork, `22:54`). It keeps its height whether it shows
 * or not, so showing it never moves the messages around it. Put it as the last child of the element that holds the message: that element is what the
 * pointer or the focus has to be on (see the stylesheet).
 */
export function MessageActions({ text, at, align, actions }: MessageActionsProps) {
    const { show, onReply, onEdit, onFork, forkState } = actions;
    const time = <time className={ styles.time } dateTime={ new Date(at).toISOString() } title={ formatFullTime(at) }>{ formatMessageTime(at) }</time>;
    const hasText = text.trim() !== '';

    return (
        <div className={ styles.row } data-align={ align } data-show={ show }>
            { align === 'end' && time }
            { /* A message of files alone has nothing to copy or quote, so no group of those: its empty box would still move the time. Edit stays, since it can be given words. */ }
            <Show when={ hasText || onEdit }>
                <div className={ styles.buttons }>
                    <Show when={ hasText }>
                        <CopyButton value={ text } variant="filling" size="xs" tooltip="Copy message" tooltipPlacement="bottom" aria-label="Copy message" />
                    </Show>
                    <Show when={ onEdit }>
                        { edit => (
                            <Button variant="filling" size="xs" iconOnly tooltip="Edit message" tooltipPlacement="bottom" aria-label="Edit message" onPress={ edit }>
                                <EditPen />
                            </Button>
                        ) }
                    </Show>
                    <Show when={ hasText && onReply }>
                        { reply => (
                            <Button variant="filling" size="xs" iconOnly tooltip="Reply" tooltipPlacement="bottom" aria-label="Reply" onPress={ () => reply(text) }>
                                <Reply />
                            </Button>
                        ) }
                    </Show>
                    <Show when={ onFork }>
                        { fork => (
                            <Button
                                variant="filling"
                                size="xs"
                                iconOnly
                                tooltip="Fork into new chat"
                                tooltipPlacement="bottom"
                                aria-label="Fork into new chat"
                                isPending={ forkState === 'pending' }
                                isDisabled={ forkState === 'blocked' }
                                onPress={ fork }
                            >
                                <ForkIcon />
                            </Button>
                        ) }
                    </Show>
                </div>
            </Show>
            { align === 'start' && time }
        </div>
    );
}
