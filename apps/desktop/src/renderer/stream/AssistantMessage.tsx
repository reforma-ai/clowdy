import { Show } from '@clowdy/components/Show';

import styles from './AssistantMessage.module.css';
import { Markdown } from './Markdown';
import { MessageActions, type MessageActionsShow } from './MessageActions';

export interface AssistantMessageProps {
    text: string;
    /** The text is still arriving. */
    streaming?: boolean;
    /** When it was written, for the time of its row of actions. */
    at: number;
    /** Draws the row of actions under the message (copy, and the time it was written); without it the message has none. */
    actions?: MessageActionsShow;
}

/** What an agent wrote: its text, which is Markdown, across the width, with a row of actions under it when it is given one. */
export function AssistantMessage({ text, streaming, at, actions }: AssistantMessageProps) {
    return (
        <div className={ styles.message }>
            <Markdown text={ text } streaming={ streaming } />
            <Show when={ actions }>
                { show => <MessageActions text={ text } at={ at } align="start" show={ show } /> }
            </Show>
        </div>
    );
}
