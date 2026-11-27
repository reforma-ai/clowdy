import { Fragment, useMemo } from 'react';

import { ApprovalCard } from './ApprovalCard';
import { AssistantMessage } from './AssistantMessage';
import { CompactionLine } from './CompactionLine';
import { COMPACT_TOOL } from './compaction';
import { EditMessage } from './EditMessage';
import { ErrorLine } from './ErrorLine';
import { NoteLine } from './NoteLine';
import { QuestionCard } from './QuestionCard';
import { ReasoningLine } from './ReasoningLine';
import { SubagentCard } from './SubagentCard';
import { isSubagentTool } from './subagents';
import { ThreadMessageCard, ThreadNoticeCards } from './ThreadCards';
import { ToolCard } from './ToolCard';
import { ToolGroup } from './ToolGroup';
import { groupToolRuns, type ItemBlock, type StreamBlock } from './turns';
import { UserBubble } from './UserBubble';
import { Worked } from './Worked';

import type { ApprovalDecision, StreamItem } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { MessageActionsConfig, MessageActionsShow } from './MessageActions';
import type { StreamEditing, StreamMessageActions } from './StreamView';

/**
 * What every row of a stream shares: the handlers and the state of the page around it. `StreamView` keeps it stable while they stay, so a row
 * draws again only when its own item changes, and a streamed chunk draws only the message it lands in.
 */
export interface StreamRowContext {
    messageActions?: StreamMessageActions;
    editing?: StreamEditing;
    onAnswer?: (questionId: string, answer: string) => void | Promise<void>;
    onDecide?: (approvalId: string, decision: ApprovalDecision) => void | Promise<void>;
    dockedQuestionId?: string;
    errorAction?: (item: StreamItem) => ReactNode;
    active: boolean;
}

/** One item of the stream. `show` is when the row of actions under a message shows; none for an item that has no row. */
export function StreamRow({
    item,
    answer = false,
    show,
    context,
}: {
    item: StreamItem;
    answer?: boolean;
    show?: MessageActionsShow;
    context: StreamRowContext;
}) {
    const actions = useMemo(
        () => (show === undefined ? undefined : rowActions(item, answer, show, context)),
        [item, answer, show, context]
    );
    const { body } = item;
    const { editing, active, onAnswer, onDecide, dockedQuestionId, errorAction } = context;

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
            return (
                <AssistantMessage
                    itemId={item.id}
                    text={body.text}
                    streaming={!body.done}
                    at={item.at}
                    actions={actions}
                />
            );
        case 'reasoning':
            return <ReasoningLine body={body} />;
        case 'tool':
            // A call that started a sub-agent is that agent's card, a compaction is a quiet line of its own; every other call is a tool line.
            if (body.name === COMPACT_TOOL) return <CompactionLine call={body} active={active} />;

            return isSubagentTool(body.name) ? <SubagentCard call={body} active={active} /> : <ToolCard call={body} />;
        case 'note':
            return <NoteLine text={body.text} at={item.at} />;
        case 'question':
            return (
                <QuestionCard
                    question={body}
                    onAnswer={onAnswer && (answer => onAnswer(body.questionId, answer))}
                    docked={body.questionId === dockedQuestionId}
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
}

/** The work of a finished turn under its "Worked for" line. The tool runs are grouped only when the block changes, and `Worked` mounts them only while open. */
export function WorkedRow({
    block,
    context,
}: {
    block: Extract<StreamBlock, { kind: 'worked' }>;
    context: StreamRowContext;
}) {
    return (
        <Worked label={block.label}>
            {groupToolRuns(block.items.map((item): ItemBlock => ({ kind: 'item', item }))).map(part =>
                part.kind === 'tools' ? (
                    <ToolGroup key={part.key} items={part.items} />
                ) : (
                    <Fragment key={part.item.id}>
                        <StreamRow item={part.item} context={context} />
                    </Fragment>
                )
            )}
        </Worked>
    );
}

/** The row under a message: what `messageActions` offers for this item. A reply names who wrote the message, and a fork and an edit the item they are made at. */
function rowActions(
    item: StreamItem,
    answer: boolean,
    show: MessageActionsShow,
    { messageActions = {}, editing }: StreamRowContext
): MessageActionsConfig {
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
    const { id, canFork, canEdit, body } = item;
    const actions: MessageActionsConfig = { ...shared, show };

    // The reply says who wrote the message: the person, or the agent whose answer it is.
    if (onReply) actions.onReply = text => onReply({ role: body.kind === 'user' ? 'user' : 'assistant', text });

    if (onFork && canFork && answer) {
        actions.onFork = () => onFork(id);

        if (onHandoff) actions.onHandoff = agentId => onHandoff(id, agentId);

        if (forkingId !== undefined) actions.forkState = forkingId === id ? 'pending' : 'blocked';
    } else if (onHandoff && ownAgent && answer) {
        // The agent cannot cut its session at this answer, so Fork does what a hand-off does: a new-chat page on the same agent with the conversation attached. It asks nothing
        // of the daemon, so it waits for no fork that is being made.
        actions.onFork = () => onHandoff(id, ownAgent);
        actions.onHandoff = agentId => onHandoff(id, agentId);
    }

    // One message is edited at a time: while its frame is open the others offer no Edit. None while the agent works either: a button that cannot be pressed is only noise.
    if (onEdit && canEdit && body.kind === 'user' && !editing && !editBusy) actions.onEdit = () => onEdit(id);

    return actions;
}
