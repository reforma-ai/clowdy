import { Button } from '@clowdy/components/Button';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { useStickToBottom } from '@clowdy/components/hooks';
import { Show } from '@clowdy/components/Show';
import { ArrowDown } from '@clowdy/icons/14';
import { mergeRefs } from '@clowdy/lib';
import { Fragment, useEffect, useImperativeHandle, useMemo, useRef } from 'react';

import { ApprovalCard } from './ApprovalCard';
import { AssistantMessage } from './AssistantMessage';
import { CompactionLine } from './CompactionLine';
import { COMPACT_TOOL } from './compaction';
import { EditMessage } from './EditMessage';
import { ErrorLine } from './ErrorLine';
import { ForkDivider, type ForkOrigin } from './ForkDivider';
import { NoteLine } from './NoteLine';
import { QuestionCard } from './QuestionCard';
import { ReasoningLine } from './ReasoningLine';
import { SelectionReply } from './SelectionReply';
import { NO_LINKS, type StreamLinks, StreamLinksContext } from './StreamLinks';
import styles from './StreamView.module.css';
import { SubagentCard } from './SubagentCard';
import { isSubagentTool } from './subagents';
import { ThreadMessageCard, ThreadNoticeCards } from './ThreadCards';
import { ToolCard } from './ToolCard';
import { ToolGroup } from './ToolGroup';
import { TurnRail } from './TurnRail';
import { turnMarks } from './turnMarks';
import {
    foldFinishedWork,
    forkPointId,
    groupToolRuns,
    hasMessageActions,
    type ItemBlock,
    type StreamBlock,
} from './turns';
import { UserBubble } from './UserBubble';
import { Worked } from './Worked';
import { WorkingLine } from './WorkingLine';

import type { ApprovalDecision, StreamItem } from '@clowdy/protocol';
import type { CSSProperties, ReactNode, Ref } from 'react';
import type { MessageActionsConfig, ReplyMessage } from './MessageActions';

/**
 * What `StreamView` is given for the row under a message: `MessageActionsConfig`, except that a reply names who wrote the message and a fork and an edit are told
 * by the item they are made at.
 */
export interface StreamMessageActions
    extends Omit<MessageActionsConfig, 'show' | 'onReply' | 'onFork' | 'forkState' | 'onHandoff' | 'onEdit'> {
    /** Reply to a whole message, from its row or by swiping it: called with who wrote it and its source Markdown. */
    onReply?: (message: ReplyMessage) => void;
    /** Quote the words selected inside one message (the floating Reply button of `SelectionReply`): called with them as they are drawn. Not drawn without it. */
    onQuote?: (text: string) => void;
    /** Fork the chat at an answer (the id of its item): drawn under an answer that the daemon marked `canFork`. */
    onFork?: (itemId: string) => void;
    /**
     * The agent the chat runs on (its id). Under a final answer the daemon did not mark `canFork` (the agent has no `session/fork`, or the answer holds no rewind point) Fork is a
     * hand-off of the conversation to this agent (`onHandoff`), which the person sees as the same Fork. Without it such answers have no Fork.
     */
    ownAgent?: string;
    /** The answer a fork is being made at: its button spins and the others of the stream wait. */
    forkingId?: string;
    /** Hand the conversation up to an answer (the id of its item) to another agent (the id of the one picked): the second item of the Fork menu, drawn beside `onFork` with `handoffAgents`. */
    onHandoff?: (itemId: string, agentId: string) => void;
    /** Edit a message of the person's (the id of its item): drawn under one that the daemon marked `canEdit`, and under none while a message is being edited (`StreamView` `editing`). */
    onEdit?: (itemId: string) => void;
    /** The agent is working: Edit is not drawn at all, since the chat can be rewritten only at rest. */
    editBusy?: boolean;
}

/** A message of the person's that is being edited in place: its bubble is replaced by the `Editing message` frame around the message box of the edit. */
export interface StreamEditing {
    /** The stream item that is edited. A stream that does not have it draws nothing for the edit. */
    itemId: string;
    /** The message box of the edit, which the stream draws in the frame. The caller makes it: it knows the draft, the files and what Enter sends. */
    editor: ReactNode;
    /** The X of the frame. */
    onCancel: () => void;
}

/** An explicit request to follow new messages, for example when the person sends one. */
export interface StreamViewHandle {
    followLatest: () => void;
}

export interface StreamViewProps {
    ref?: Ref<StreamViewHandle>;
    items: StreamItem[];
    /** Height in pixels occupied by a composer overlaid on the bottom of the stream. */
    composerInset?: number;
    /** The run is going, or waits for the person: its latest turn stays open. Once it is over, that turn folds its work too. */
    active?: boolean;
    /**
     * The run is going: ends the stream with a live line. A string replaces the default "Working…", and says the run waits for something else (a free slot, background
     * work) instead of working. With `true`, a collapsed tool group at the end can show its latest running tool on the live line.
     */
    working?: boolean | string;
    /** The person answered a `question` item. */
    onAnswer?: (questionId: string, answer: string) => void | Promise<void>;
    /** The person decided an `approval` item that is `open`. A card is read-only without it, and so is one that is not open. */
    onDecide?: (approvalId: string, decision: ApprovalDecision) => void | Promise<void>;
    /** Shown while there are no items. */
    emptyState?: ReactNode;
    /** Rendered right after an item, in the stream's own flow. */
    decorate?: (item: StreamItem) => ReactNode;
    /** What the text may point at in the app: a task key becomes a chip that opens the task. */
    links?: StreamLinks;
    /** A button at the end of an error, for what fixes it: a chat whose context overflowed offers Compact on its failure. */
    errorAction?: (item: StreamItem) => ReactNode;
    /**
     * Draws a row of actions and the time under the person's own messages and under the answer of each turn that is over, shown on the pointer
     * or the focus and always under the last one. Off for a page that only reads a run. Copy comes with the row; the other actions are drawn
     * when their handler is here: `onReply` adds Reply (and, with `swipeToReply`, the swipe that does the same), `onQuote` gives a selection inside one
     * message a Reply button (`SelectionReply`), `onFork` adds Fork to an answer that carries `canFork`, and `onEdit` adds Edit to a message of the
     * person's that carries `canEdit`.
     */
    messageActions?: StreamMessageActions;
    /** A message is being edited in place: the frame stands where its bubble was, and no other message offers Edit meanwhile. The rest of the stream stays as it is. */
    editing?: StreamEditing;
    /** The chat is a fork: draws the divider where the history it inherited ends, which stays for the life of the chat. Off for a page that only reads a run. */
    forkedFrom?: ForkOrigin;
}

/**
 * A run's stream: the person's messages, the agent's, tool calls, notes, questions, requests for permission and errors, and the cards of other threads (a message from one,
 * threads that stopped), kept scrolled to the end
 * while it is there. A turn that is over shows what was asked and the answer, and the work between them under one
 * "Worked for" line.
 */
export function StreamView({
    items,
    composerInset = 0,
    active = false,
    working,
    onAnswer,
    onDecide,
    emptyState,
    decorate,
    links = NO_LINKS,
    errorAction,
    messageActions,
    editing,
    forkedFrom,
    ref,
}: StreamViewProps) {
    const scroller = useRef<HTMLDivElement>(null);
    const inset = Number.isFinite(composerInset) ? Math.max(0, composerInset) : 0;
    const { scrollRef: stickScrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom();
    useImperativeHandle(ref, () => ({ followLatest: () => scrollToBottom({ animation: 'instant' }) }), [
        scrollToBottom,
    ]);
    const scrollRef = useMemo(
        () => mergeRefs<HTMLDivElement>(scroller, node => stickScrollRef(node)),
        [stickScrollRef]
    );
    const marks = useMemo(() => turnMarks(items), [items]);
    const blocks = useMemo(() => groupToolRuns(foldFinishedWork(items, active)), [items, active]);
    const lastWithActions = messageActions ? blocks.findLast(hasMessageActions)?.item.id : undefined;
    const forkPoint = forkedFrom && forkPointId(items, forkedFrom.atSeq);
    const last = items.at(-1)?.body;
    const lastBlock = blocks.at(-1);
    const liveToolGroup = working === true && lastBlock?.kind === 'tools' ? lastBlock : undefined;
    // A message or a thought that is still arriving carries its own marker, and so does a compaction that runs (Reforma hides its pending line the same way).
    const live =
        ((last?.kind === 'assistant' || last?.kind === 'reasoning') && !last.done) ||
        (last?.kind === 'tool' && last.name === COMPACT_TOOL && last.state === 'running');
    const showWorking = Boolean(working) && !live && !liveToolGroup;

    // A frame closed with the focus in it (Escape, the X) hands the focus back to its message's Edit button.
    const editedId = editing?.itemId;
    const framed = useRef<string>(undefined);

    useEffect(() => {
        const was = framed.current;

        framed.current = editedId;

        if (editedId !== undefined) return;

        // A focus that is somewhere else (the box at the bottom, typed in while a message went) is not taken back.
        if (was === undefined || (document.activeElement && document.activeElement !== document.body)) return;

        [...(scroller.current?.querySelectorAll<HTMLElement>('[data-turn]') ?? [])]
            .find(row => row.dataset.turn === was)
            ?.querySelector<HTMLElement>('[aria-label="Edit message"]')
            ?.focus();
    }, [editedId]);

    /** The row a block gets: none unless the caller asked for rows and the block is a message that has one; the last of them always shows. */
    const actionsOf = (block: StreamBlock): MessageActionsConfig | undefined => {
        if (!messageActions || !hasMessageActions(block)) return undefined;

        const {
            onFork,
            forkingId,
            onHandoff,
            ownAgent,
            onEdit,
            editBusy,
            onReply,
            onQuote: _onQuote,
            ...shared
        } = messageActions;
        const { id, canFork, canEdit, body } = block.item;
        const actions: MessageActionsConfig = { ...shared, show: id === lastWithActions ? 'always' : 'hover' };

        // The reply says who wrote the message: the person, or the agent whose answer it is.
        if (onReply) actions.onReply = text => onReply({ role: body.kind === 'user' ? 'user' : 'assistant', text });

        if (onFork && canFork && block.answer) {
            actions.onFork = () => onFork(id);

            if (onHandoff) actions.onHandoff = agentId => onHandoff(id, agentId);

            if (forkingId !== undefined) actions.forkState = forkingId === id ? 'pending' : 'blocked';
        } else if (onHandoff && ownAgent && block.answer) {
            // The agent cannot cut its session at this answer, so Fork does what a hand-off does: a new-chat page on the same agent with the conversation attached. It asks nothing
            // of the daemon, so it waits for no fork that is being made.
            actions.onFork = () => onHandoff(id, ownAgent);
            actions.onHandoff = agentId => onHandoff(id, agentId);
        }

        // One message is edited at a time: while its frame is open the others offer no Edit. None while the agent works either: a button that cannot be pressed is only noise.
        if (onEdit && canEdit && body.kind === 'user' && !editing && !editBusy) actions.onEdit = () => onEdit(id);

        return actions;
    };

    const divider = forkedFrom && <ForkDivider title={forkedFrom.title} onOpen={forkedFrom.onOpen} />;

    /** The divider of a fork goes after the block that holds its fork point: the answer itself, or the fold the point is inside. */
    const endsHistory = (block: StreamBlock) =>
        forkPoint !== undefined &&
        (block.kind === 'item' ? block.item.id === forkPoint : block.items.some(item => item.id === forkPoint));

    const renderItem = (item: StreamItem, actions?: MessageActionsConfig): ReactNode => {
        const { body } = item;

        switch (body.kind) {
            case 'user':
                // A message another thread wrote, or threads that stopped, is a card: the person did not write it.
                if (body.from?.kind === 'thread')
                    return (
                        <ThreadMessageCard
                            turn={item.id}
                            chatId={body.from.chatId}
                            title={body.from.title}
                            text={body.text}
                        />
                    );

                if (body.from?.kind === 'threadNotice')
                    return <ThreadNoticeCards turn={item.id} threads={body.from.threads} />;

                if (editing?.itemId === item.id)
                    return (
                        <EditMessage turn={item.id} onCancel={editing.onCancel}>
                            {editing.editor}
                        </EditMessage>
                    );

                return (
                    <UserBubble
                        turn={item.id}
                        text={body.text}
                        attachments={body.attachments}
                        at={item.at}
                        actions={actions}
                    />
                );
            case 'assistant':
                return <AssistantMessage text={body.text} streaming={!body.done} at={item.at} actions={actions} />;
            case 'reasoning':
                return <ReasoningLine body={body} />;
            case 'tool':
                // A call that started a sub-agent is that agent's card, a compaction is a quiet line of its own; every other call is a tool line.
                if (body.name === COMPACT_TOOL) return <CompactionLine call={body} active={active} />;

                return isSubagentTool(body.name) ? (
                    <SubagentCard call={body} active={active} />
                ) : (
                    <ToolCard call={body} />
                );
            case 'note':
                return <NoteLine text={body.text} at={item.at} />;
            case 'question':
                return (
                    <QuestionCard
                        question={body}
                        onAnswer={onAnswer && (answer => onAnswer(body.questionId, answer))}
                    />
                );
            case 'approval':
                return (
                    <ApprovalCard
                        approval={body}
                        onDecide={onDecide && (decision => onDecide(body.approvalId, decision))}
                    />
                );
            case 'error':
                return <ErrorLine text={body.text} action={errorAction?.(item)} />;
        }
    };

    return (
        <StreamLinksContext value={links}>
            <div
                className={styles.root}
                data-composer-overlay={inset > 0 || undefined}
                style={{ '--composer-inset': `${inset}px` } as CSSProperties}
            >
                <div ref={scrollRef} className={styles.scroll}>
                    <ContentColumn ref={contentRef} className={styles.content}>
                        {items.length === 0 && emptyState}
                        {blocks.map(block => {
                            switch (block.kind) {
                                case 'worked':
                                    return (
                                        <Fragment key={block.key}>
                                            <Worked label={block.label}>
                                                {groupToolRuns(
                                                    block.items.map((item): ItemBlock => ({ kind: 'item', item }))
                                                ).map(part =>
                                                    part.kind === 'tools' ? (
                                                        <ToolGroup key={part.key} items={part.items} />
                                                    ) : (
                                                        <Fragment key={part.item.id}>{renderItem(part.item)}</Fragment>
                                                    )
                                                )}
                                            </Worked>
                                            {endsHistory(block) && divider}
                                        </Fragment>
                                    );
                                case 'tools':
                                    return (
                                        <Fragment key={block.key}>
                                            <ToolGroup items={block.items} live={block === liveToolGroup} />
                                            {endsHistory(block) && divider}
                                        </Fragment>
                                    );
                                case 'item':
                                    return (
                                        <Fragment key={block.item.id}>
                                            {renderItem(block.item, actionsOf(block))}
                                            {endsHistory(block) && divider}
                                            {decorate?.(block.item)}
                                        </Fragment>
                                    );
                            }
                        })}
                        {showWorking && <WorkingLine text={typeof working === 'string' ? working : undefined} />}
                        {inset > 0 && <div className={styles.clearance} aria-hidden="true" />}
                    </ContentColumn>
                </div>

                <TurnRail marks={marks} scroller={scroller} />

                <Show when={messageActions?.onQuote}>
                    {onQuote => <SelectionReply scope={scroller} onReply={onQuote} />}
                </Show>

                <Button
                    variant="bordered"
                    color="secondary"
                    size="sm"
                    iconOnly
                    rounded
                    className={styles.toLatest}
                    data-hidden={isAtBottom || undefined}
                    tooltip="Scroll to latest messages"
                    aria-label="Scroll to latest messages"
                    onPress={() => scrollToBottom()}
                >
                    <ArrowDown />
                </Button>
            </div>
        </StreamLinksContext>
    );
}
