import { Button } from '@clowdy/components/Button';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { useStickToBottom } from '@clowdy/components/hooks';
import { ArrowDown } from '@clowdy/icons/14';
import { Fragment, useMemo, useState } from 'react';

import { AssistantMessage } from './AssistantMessage';
import { ErrorLine } from './ErrorLine';
import { NoteLine } from './NoteLine';
import { QuestionCard } from './QuestionCard';
import { NO_LINKS, StreamLinksContext, type StreamLinks } from './StreamLinks';
import styles from './StreamView.module.css';
import { SpawnCard, SubagentCard } from './SubagentCard';
import { isSubagentTool, RUN_SPAWN } from './subagents';
import { ToolCard } from './ToolCard';
import { foldFinishedWork } from './turns';
import { UserBubble } from './UserBubble';
import { Worked } from './Worked';
import { WorkingLine } from './WorkingLine';

import type { StreamItem } from '@clowdy/protocol';
import type { ReactNode } from 'react';

export interface StreamViewProps {
    items: StreamItem[];
    /** The run is going, or waits for the person: its latest turn stays open. Once it is over, that turn folds its work too. */
    active?: boolean;
    /** The run is going: ends the stream with a live line. A string replaces the default "Working…". */
    working?: boolean | string;
    /** The person answered a `question` item. */
    onAnswer?: (questionId: string, answer: string) => void | Promise<void>;
    /** Shown while there are no items. */
    emptyState?: ReactNode;
    /** Rendered right after an item, in the stream's own flow: the progress card of a chat sits after a message. */
    decorate?: (item: StreamItem) => ReactNode;
    /** What the text may point at in the app: a task key becomes a chip that opens the task. */
    links?: StreamLinks;
}

/**
 * A run's stream: the person's messages, the agent's, tool calls, notes, questions and errors, kept scrolled to the end
 * while it is there. A turn that is over shows what was asked and the answer, and the work between them under one
 * "Worked for" line.
 */
export function StreamView({ items, active = false, working, onAnswer, emptyState, decorate, links = NO_LINKS }: StreamViewProps) {
    const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom();
    // What was there when the stream first showed is not news: only a message that comes later rises into place.
    const [shown] = useState(() => new Set(items.map(item => item.id)));
    const blocks = useMemo(() => foldFinishedWork(items, active), [items, active]);
    const last = items.at(-1)?.body;
    // A message that is still arriving carries its own marker.
    const showWorking = Boolean(working) && !(last?.kind === 'assistant' && !last.done);

    const renderItem = (item: StreamItem): ReactNode => {
        const { body } = item;

        switch (body.kind) {
            case 'user':
                return <UserBubble text={ body.text } attachments={ body.attachments } at={ item.at } animate={ !shown.has(item.id) } />;
            case 'assistant':
                return <AssistantMessage text={ body.text } streaming={ !body.done } />;
            case 'tool':
                // A call that started another agent is that agent's card; every other call is a line.
                if (body.name === RUN_SPAWN) return <SpawnCard call={ body } />;

                return isSubagentTool(body.name) ? <SubagentCard call={ body } active={ active } /> : <ToolCard call={ body } />;
            case 'note':
                return <NoteLine text={ body.text } at={ item.at } />;
            case 'question':
                return <QuestionCard question={ body } onAnswer={ onAnswer && (answer => onAnswer(body.questionId, answer)) } />;
            case 'error':
                return <ErrorLine text={ body.text } />;
        }
    };

    return (
        <StreamLinksContext value={ links }>
            <div className={ styles.root }>
                <div ref={ scrollRef } className={ styles.scroll }>
                    <ContentColumn ref={ contentRef } className={ styles.content }>
                        { items.length === 0 && emptyState }
                        { blocks.map(block => (block.kind === 'worked'
                            ? (
                                <Worked key={ block.key } label={ block.label }>
                                    { block.items.map(item => <Fragment key={ item.id }>{ renderItem(item) }</Fragment>) }
                                </Worked>
                            )
                            : (
                                <Fragment key={ block.item.id }>
                                    { renderItem(block.item) }
                                    { decorate?.(block.item) }
                                </Fragment>
                            ))) }
                        { showWorking && <WorkingLine text={ typeof working === 'string' ? working : undefined } /> }
                    </ContentColumn>
                </div>

                <Button
                    variant="bordered"
                    color="secondary"
                    size="sm"
                    iconOnly
                    rounded
                    className={ styles.toLatest }
                    data-hidden={ isAtBottom || undefined }
                    tooltip="Scroll to latest messages"
                    aria-label="Scroll to latest messages"
                    onPress={ () => scrollToBottom() }
                >
                    <ArrowDown />
                </Button>
            </div>
        </StreamLinksContext>
    );
}
