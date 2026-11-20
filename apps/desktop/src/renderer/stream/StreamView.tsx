import { Button } from '@clowdy/components/Button';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { useStickToBottom } from '@clowdy/components/hooks';
import { ArrowDown } from '@clowdy/icons/14';
import { mergeRefs } from '@clowdy/lib';
import { Fragment, useMemo, useRef, useState } from 'react';

import { AssistantMessage } from './AssistantMessage';
import { COMPACT_TOOL } from './compaction';
import { CompactionLine } from './CompactionLine';
import { ErrorLine } from './ErrorLine';
import { NoteLine } from './NoteLine';
import { QuestionCard } from './QuestionCard';
import { NO_LINKS, StreamLinksContext, type StreamLinks } from './StreamLinks';
import styles from './StreamView.module.css';
import { SubagentCard } from './SubagentCard';
import { isSubagentTool } from './subagents';
import { ThreadMessageCard, ThreadNoticeCards } from './ThreadCards';
import { ToolCard } from './ToolCard';
import { turnMarks } from './turnMarks';
import { TurnRail } from './TurnRail';
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
    /** A button at the end of an error, for what fixes it: a chat whose context overflowed offers Compact on its failure. */
    errorAction?: (item: StreamItem) => ReactNode;
}

/**
 * A run's stream: the person's messages, the agent's, tool calls, notes, questions and errors, and the cards of other threads (a message from one,
 * threads that stopped), kept scrolled to the end
 * while it is there. A turn that is over shows what was asked and the answer, and the work between them under one
 * "Worked for" line.
 */
export function StreamView({ items, active = false, working, onAnswer, emptyState, decorate, links = NO_LINKS, errorAction }: StreamViewProps) {
    const scroller = useRef<HTMLDivElement>(null);
    const { scrollRef: stickScrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom();
    const scrollRef = useMemo(
        () => mergeRefs<HTMLDivElement>(scroller, node => stickScrollRef(node)),
        [stickScrollRef]
    );
    const marks = useMemo(() => turnMarks(items), [items]);
    // What was there when the stream first showed is not news: only a message that comes later rises into place.
    const [shown] = useState(() => new Set(items.map(item => item.id)));
    const blocks = useMemo(() => foldFinishedWork(items, active), [items, active]);
    const last = items.at(-1)?.body;
    // A message that is still arriving carries its own marker, and so does a compaction that runs (Reforma hides its pending line the same way).
    const live = (last?.kind === 'assistant' && !last.done) || (last?.kind === 'tool' && last.name === COMPACT_TOOL && last.state === 'running');
    const showWorking = Boolean(working) && !live;

    const renderItem = (item: StreamItem): ReactNode => {
        const { body } = item;

        switch (body.kind) {
            case 'user':
                // A message another thread wrote, or threads that stopped, is a card: the person did not write it.
                if (body.from?.kind === 'thread') return <ThreadMessageCard turn={ item.id } chatId={ body.from.chatId } title={ body.from.title } text={ body.text } />;

                if (body.from?.kind === 'threadNotice') return <ThreadNoticeCards turn={ item.id } threads={ body.from.threads } />;

                return <UserBubble turn={ item.id } text={ body.text } attachments={ body.attachments } at={ item.at } animate={ !shown.has(item.id) } />;
            case 'assistant':
                return <AssistantMessage text={ body.text } streaming={ !body.done } />;
            case 'tool':
                // A call that started a sub-agent is that agent's card, a compaction is a quiet line of its own; every other call is a tool line.
                if (body.name === COMPACT_TOOL) return <CompactionLine call={ body } active={ active } />;

                return isSubagentTool(body.name) ? <SubagentCard call={ body } active={ active } /> : <ToolCard call={ body } />;
            case 'note':
                return <NoteLine text={ body.text } at={ item.at } />;
            case 'question':
                return <QuestionCard question={ body } onAnswer={ onAnswer && (answer => onAnswer(body.questionId, answer)) } />;
            case 'error':
                return <ErrorLine text={ body.text } action={ errorAction?.(item) } />;
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

                <TurnRail marks={ marks } scroller={ scroller } />

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
