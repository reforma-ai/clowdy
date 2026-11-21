import { Show } from '@clowdy/components/Show';

import styles from './AssistantMessage.module.css';
import { Markdown } from './Markdown';
import { MessageActions, type MessageActionsConfig } from './MessageActions';

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
    return (
        <div className={ styles.message } data-message="">
            <Markdown text={ text } streaming={ streaming } />
            <Show when={ actions }>
                { config => <MessageActions text={ text } at={ at } align="start" actions={ config } /> }
            </Show>
        </div>
    );
}
