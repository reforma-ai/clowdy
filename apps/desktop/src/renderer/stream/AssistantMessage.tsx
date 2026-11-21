import { Show } from '@clowdy/components/Show';

import styles from './AssistantMessage.module.css';
import { Markdown } from './Markdown';
import { MessageActions, type MessageActionsConfig } from './MessageActions';
import { SwipeHint } from './SwipeHint';
import { useSwipeReply } from './useSwipeReply';

export interface AssistantMessageProps {
    text: string;
    /** The text is still arriving. */
    streaming?: boolean;
    /** When it was written, for the time of its row of actions. */
    at: number;
    /** Draws the row of actions under the message (the time it was written, and what it offers); without it the message has none. */
    actions?: MessageActionsConfig;
}

/**
 * What an agent wrote: its text, which is Markdown, across the width, with a row of actions under it when it is given one. The root is marked
 * `data-message`: a selection is quoted by `SelectionReply` only when it lies inside one such element.
 */
export function AssistantMessage({ text, streaming, at, actions }: AssistantMessageProps) {
    // A swipe is the Reply button's other way in: it needs the same handler and words.
    const swipes = Boolean(actions?.onReply && actions.swipeToReply && text.trim() !== '');
    const message = useSwipeReply<HTMLDivElement>({ enabled: swipes, onReply: () => actions?.onReply?.(text) });

    return (
        <div ref={ message } className={ styles.message } data-message="">
            { /* Before the row of actions, which stays the last child of the message (see `MessageActions`). */ }
            <Show when={ swipes }>
                <SwipeHint />
            </Show>
            <Markdown text={ text } streaming={ streaming } />
            <Show when={ actions }>
                { config => <MessageActions text={ text } at={ at } align="start" actions={ config } /> }
            </Show>
        </div>
    );
}
