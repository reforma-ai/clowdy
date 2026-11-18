import styles from './AssistantMessage.module.css';
import { Markdown } from './Markdown';

export interface AssistantMessageProps {
    text: string;
    /** The text is still arriving. */
    streaming?: boolean;
}

/** What an agent wrote: its text, which is Markdown, across the width. */
export function AssistantMessage({ text, streaming }: AssistantMessageProps) {
    return (
        <div className={ styles.message }>
            <Markdown text={ text } streaming={ streaming } />
        </div>
    );
}
