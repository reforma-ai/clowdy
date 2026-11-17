import { useStickToBottom } from '@clowdy/components/hooks';
import { Fragment } from 'react';

import { AgentAvatar } from './AgentAvatar';
import { AssistantMessage } from './AssistantMessage';
import { ErrorLine } from './ErrorLine';
import { NoteLine } from './NoteLine';
import { QuestionCard } from './QuestionCard';
import styles from './StreamView.module.css';
import { ToolCard } from './ToolCard';
import { UserBubble } from './UserBubble';
import { WorkingLine } from './WorkingLine';

import type { StreamItem } from '@clowdy/protocol';
import type { ReactNode } from 'react';

export interface StreamViewProps {
    items: StreamItem[];
    /** The name over the agent's messages: `Orchestrator`, `Executor 07`. */
    agentName: string;
    /** Beside the agent's messages. Defaults to the orchestrator's avatar. */
    avatar?: ReactNode;
    /**
     * Who the `user` items come from when they are not the person: the run that handed this one its assignment.
     * Without it they are the person's own messages, as bubbles on the right.
     */
    sender?: { name: string; avatar?: ReactNode };
    /** The run is going: ends the stream with a live line. A string replaces the default "Working…". */
    working?: boolean | string;
    /** The person answered a `question` item. */
    onAnswer?: (questionId: string, answer: string) => void | Promise<void>;
    /** Shown while there are no items. */
    emptyState?: ReactNode;
    /** Rendered right after an item, in the stream's own flow: the progress card of a chat sits after a message. */
    decorate?: (item: StreamItem) => ReactNode;
}

/** A run's stream: messages, tool calls, notes, questions and errors, kept scrolled to the end while it is there. */
export function StreamView({ items, agentName, avatar = <AgentAvatar />, sender, working, onAnswer, emptyState, decorate }: StreamViewProps) {
    const { scrollRef, contentRef } = useStickToBottom();
    const last = items.at(-1)?.body;
    // A message that is still arriving carries its own marker.
    const showWorking = Boolean(working) && !(last?.kind === 'assistant' && !last.done);

    const renderItem = (item: StreamItem, index: number): ReactNode => {
        const { body } = item;

        switch (body.kind) {
            case 'user':
                return sender
                    ? <AssistantMessage name={ sender.name } avatar={ sender.avatar } at={ item.at } text={ body.text } />
                    : <UserBubble text={ body.text } at={ item.at } />;
            case 'assistant':
                return (
                    <AssistantMessage
                        name={ agentName }
                        avatar={ avatar }
                        at={ item.at }
                        text={ body.text }
                        streaming={ !body.done }
                        // The next message of a run in a row leaves the header out.
                        showHeader={ items[index - 1]?.body.kind === undefined || items[index - 1].body.kind === 'user' }
                    />
                );
            case 'tool':
                return <ToolCard call={ body } />;
            case 'note':
                return <NoteLine text={ body.text } at={ item.at } />;
            case 'question':
                return <QuestionCard question={ body } onAnswer={ onAnswer && (answer => onAnswer(body.questionId, answer)) } />;
            case 'error':
                return <ErrorLine text={ body.text } />;
        }
    };

    return (
        <div ref={ scrollRef } className={ styles.scroll }>
            <div ref={ contentRef } className={ styles.content }>
                { items.length === 0 && emptyState }
                { items.map((item, index) => (
                    <Fragment key={ item.id }>
                        { renderItem(item, index) }
                        { decorate?.(item) }
                    </Fragment>
                )) }
                { showWorking && <WorkingLine text={ typeof working === 'string' ? working : undefined } /> }
            </div>
        </div>
    );
}
