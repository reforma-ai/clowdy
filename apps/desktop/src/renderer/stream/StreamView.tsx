import { Button } from '@clowdy/components/Button';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { useStickToBottom } from '@clowdy/components/hooks';
import { Show } from '@clowdy/components/Show';
import { ArrowDown } from '@clowdy/icons/14';
import { mergeRefs } from '@clowdy/lib';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { AssistantMessage } from './AssistantMessage';
import { COMPACT_TOOL } from './compaction';
import { CompactionLine } from './CompactionLine';
import { EditMessage } from './EditMessage';
import { ErrorLine } from './ErrorLine';
import { ForkDivider, type ForkOrigin } from './ForkDivider';
import { NoteLine } from './NoteLine';
import { QuestionCard } from './QuestionCard';
import { SelectionReply } from './SelectionReply';
import { NO_LINKS, StreamLinksContext, type StreamLinks } from './StreamLinks';
import styles from './StreamView.module.css';
import { SubagentCard } from './SubagentCard';
import { isSubagentTool } from './subagents';
import { ThreadMessageCard, ThreadNoticeCards } from './ThreadCards';
import { ToolCard } from './ToolCard';
import { turnMarks } from './turnMarks';
import { TurnRail } from './TurnRail';
import { foldFinishedWork, forkPointId, hasMessageActions, type StreamBlock } from './turns';
import { UserBubble } from './UserBubble';
import { Worked } from './Worked';
import { WorkingLine } from './WorkingLine';

import type { StreamItem } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { MessageActionsConfig } from './MessageActions';

/** What `StreamView` is given for the row under a message: `MessageActionsConfig`, except that a fork and an edit are told by the item they are made at. */
export interface StreamMessageActions extends Omit<MessageActionsConfig, 'show' | 'onFork' | 'forkState' | 'onEdit' | 'editState'> {
    /** Fork the chat at an answer (the id of its item): drawn under an answer that the daemon marked `canFork`. */
    onFork?: (itemId: string) => void;
    /** The answer a fork is being made at: its button spins and the others of the stream wait. */
    forkingId?: string;
    /** Edit a message of the person's (the id of its item): drawn under one that the daemon marked `canEdit`, and under none while a message is being edited (`StreamView` `editing`). */
    onEdit?: (itemId: string) => void;
    /** The agent is working: Edit is drawn off, with the reason on a tooltip, since the chat can be rewritten only at rest. */
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
    /**
     * Draws a row of actions and the time under the person's own messages and under the answer of each turn that is over, shown on the pointer
     * or the focus and always under the last one. Off for a page that only reads a run. Copy comes with the row; the other actions are drawn
     * when their handler is here: `onReply` also gives a selection inside one message a Reply button (`SelectionReply`), `onFork` adds Fork to an
     * answer that carries `canFork`, and `onEdit` adds Edit to a message of the person's that carries `canEdit`.
     */
    messageActions?: StreamMessageActions;
    /** A message is being edited in place: the frame stands where its bubble was, and no other message offers Edit meanwhile. The rest of the stream stays as it is. */
    editing?: StreamEditing;
    /** The chat is a fork: draws the divider where the history it inherited ends, which stays for the life of the chat. Off for a page that only reads a run. */
    forkedFrom?: ForkOrigin;
}

/**
 * A run's stream: the person's messages, the agent's, tool calls, notes, questions and errors, and the cards of other threads (a message from one,
 * threads that stopped), kept scrolled to the end
 * while it is there. A turn that is over shows what was asked and the answer, and the work between them under one
 * "Worked for" line.
 */
export function StreamView({ items, active = false, working, onAnswer, emptyState, decorate, links = NO_LINKS, errorAction, messageActions, editing, forkedFrom }: StreamViewProps) {
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
    const lastWithActions = messageActions ? blocks.findLast(hasMessageActions)?.item.id : undefined;
    const forkPoint = forkedFrom && forkPointId(items, forkedFrom.atSeq);
    const last = items.at(-1)?.body;
    // A message that is still arriving carries its own marker, and so does a compaction that runs (Reforma hides its pending line the same way).
    const live = (last?.kind === 'assistant' && !last.done) || (last?.kind === 'tool' && last.name === COMPACT_TOOL && last.state === 'running');
    const showWorking = Boolean(working) && !live;

    // The frame of an edit stands in for a bubble that is drawn again when the frame goes. That bubble is no news, so it must not rise into place a second time,
    // and a frame closed with the focus in it (Escape, the X) hands the focus to its message's Edit button, where the person pressed it, instead of dropping it.
    const editedId = editing?.itemId;
    const framed = useRef<string>(undefined);

    useEffect(() => {
        const was = framed.current;

        framed.current = editedId;

        if (editedId !== undefined) {
            shown.add(editedId);

            return;
        }

        // A focus that is somewhere else (the box at the bottom, typed in while a message went) is not taken back.
        if (was === undefined || (document.activeElement && document.activeElement !== document.body)) return;

        [...scroller.current?.querySelectorAll<HTMLElement>('[data-turn]') ?? []]
            .find(row => row.dataset.turn === was)
            ?.querySelector<HTMLElement>('[aria-label="Edit message"]')
            ?.focus();
    }, [editedId, shown]);

    /** The row a block gets: none unless the caller asked for rows and the block is a message that has one; the last of them always shows. */
    const actionsOf = (block: StreamBlock): MessageActionsConfig | undefined => {
        if (!messageActions || !hasMessageActions(block)) return undefined;

        const { onFork, forkingId, onEdit, editBusy, ...shared } = messageActions;
        const { id, canFork, canEdit, body } = block.item;
        const actions: MessageActionsConfig = { ...shared, show: id === lastWithActions ? 'always' : 'hover' };

        if (onFork && canFork && block.answer) {
            actions.onFork = () => onFork(id);

            if (forkingId !== undefined) actions.forkState = forkingId === id ? 'pending' : 'blocked';
        }

        // One message is edited at a time: while its frame is open the others offer no Edit.
        if (onEdit && canEdit && body.kind === 'user' && !editing) {
            actions.onEdit = () => onEdit(id);

            if (editBusy) actions.editState = 'busy';
        }

        return actions;
    };

    const divider = forkedFrom && <ForkDivider title={ forkedFrom.title } onOpen={ forkedFrom.onOpen } />;

    /** The divider of a fork goes after the block that holds its fork point: the answer itself, or the fold the point is inside. */
    const endsHistory = (block: StreamBlock) => forkPoint !== undefined && (block.kind === 'worked' ? block.items.some(item => item.id === forkPoint) : block.item.id === forkPoint);

    const renderItem = (item: StreamItem, actions?: MessageActionsConfig): ReactNode => {
        const { body } = item;

        switch (body.kind) {
            case 'user':
                // A message another thread wrote, or threads that stopped, is a card: the person did not write it.
                if (body.from?.kind === 'thread') return <ThreadMessageCard turn={ item.id } chatId={ body.from.chatId } title={ body.from.title } text={ body.text } />;

                if (body.from?.kind === 'threadNotice') return <ThreadNoticeCards turn={ item.id } threads={ body.from.threads } />;

                if (editing?.itemId === item.id) return <EditMessage turn={ item.id } onCancel={ editing.onCancel }>{ editing.editor }</EditMessage>;

                return <UserBubble turn={ item.id } text={ body.text } attachments={ body.attachments } at={ item.at } actions={ actions } animate={ !shown.has(item.id) } />;
            case 'assistant':
                return <AssistantMessage text={ body.text } streaming={ !body.done } at={ item.at } actions={ actions } />;
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
                                <Fragment key={ block.key }>
                                    <Worked label={ block.label }>
                                        { block.items.map(item => <Fragment key={ item.id }>{ renderItem(item) }</Fragment>) }
                                    </Worked>
                                    { endsHistory(block) && divider }
                                </Fragment>
                            )
                            : (
                                <Fragment key={ block.item.id }>
                                    { renderItem(block.item, actionsOf(block)) }
                                    { endsHistory(block) && divider }
                                    { decorate?.(block.item) }
                                </Fragment>
                            ))) }
                        { showWorking && <WorkingLine text={ typeof working === 'string' ? working : undefined } /> }
                    </ContentColumn>
                </div>

                <TurnRail marks={ marks } scroller={ scroller } />

                <Show when={ messageActions?.onReply }>
                    { onReply => <SelectionReply scope={ scroller } onReply={ onReply } /> }
                </Show>

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
