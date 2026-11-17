import { Text } from '@clowdy/components/Text';

import { formatTime } from '../shared/time';
import styles from './AssistantMessage.module.css';
import { Markdown } from './Markdown';

import type { ReactNode } from 'react';

export interface AssistantMessageProps {
    name: string;
    /** Sits left of the name; see `AgentAvatar`. */
    avatar?: ReactNode;
    at: number;
    text: string;
    /** The text is still arriving. */
    streaming?: boolean;
    /** Show the avatar, name and time. A run's next message in a row leaves them out. */
    showHeader?: boolean;
}

/** What an agent wrote: the name and time over the text, which is Markdown. */
export function AssistantMessage({ name, avatar, at, text, streaming, showHeader = true }: AssistantMessageProps) {
    return (
        <div className={ styles.message }>
            <div className={ styles.avatar }>{ showHeader && avatar }</div>
            <div className={ styles.main }>
                { showHeader && (
                    <div className={ styles.header }>
                        <Text bold>{ name }</Text>
                        <time className={ styles.time } dateTime={ new Date(at).toISOString() }>{ formatTime(at) }</time>
                    </div>
                ) }
                <div className={ styles.text }>
                    <Markdown text={ text } />
                    { streaming && <span className={ styles.caret } aria-label="Still writing" role="status" /> }
                </div>
            </div>
        </div>
    );
}
