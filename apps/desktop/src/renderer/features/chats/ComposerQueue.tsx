import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { Pressable } from '@clowdy/components/Pressable';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Show } from '@clowdy/components/Show';
import { SortableList } from '@clowdy/components/SortableList';
import { Text } from '@clowdy/components/Text';
import { ArrowUp, Clip, Collapse, EditPen, Trash } from '@clowdy/icons/14';
import { type RefObject, useEffect, useRef, useState } from 'react';

import { Unavailable } from '../../shared/Unavailable';
import { useProjectState, useRootStore } from '../../stores';
import { OutcomeMark } from '../../stream/OutcomeMark';
import { worstOutcome } from '../../stream/threadMessages';
import { AgentMark } from '../agents/AgentMark';
import styles from './ComposerQueue.module.css';
import { chatEngine } from './chatProvider';
import { perform } from './commands';

import type { Chat, MessageSource, QueuedMessage, QueuePause } from '@clowdy/protocol';

const filesLabel = (count: number) => (count === 1 ? '1 file' : `${count} files`);

/**
 * What a row says of its message: the words, or the files when there are none. A message another thread wrote starts with that thread's title, so
 * the person can tell the senders apart (a notice's summary names its threads already).
 */
export function queuedLabel(item: QueuedMessage): string {
    const count = item.attachments?.length ?? 0;
    const words = item.text.trim() || (count > 0 ? filesLabel(count) : 'Queued message');

    return item.from?.kind === 'thread' ? `${item.from.title}: ${words}` : words;
}

const PAUSED: Record<QueuePause, string> = {
    stopped: 'Queue paused after Stop.',
    failed: 'Queue paused: the reply failed.',
};

/** The order a drop made, held until the daemon publishes the chat again, so the list does not jump back meanwhile. */
interface DroppedOrder {
    /** The queue the order was made from; the next one replaces it. */
    base: readonly QueuedMessage[];
    items: QueuedMessage[];
}

export interface ComposerQueueProps {
    chat: Chat;
    /** The up arrow steers the current turn while busy and starts the next turn at rest. */
    busy: boolean;
    /** The orchestrator has not finished: a compact item cannot go yet. */
    running: boolean;
    /** Edit: the message has left the queue, and its words and files go back into the message box. */
    onEdit: (item: QueuedMessage) => void;
}

/**
 * The composer's queue shows one line per item, with a leading icon for attachments, thread messages or compaction.
 * The up arrow steers or sends an item, and a steer says `Steering…` until the agent takes it. The head shows
 * actions at rest, and the other rows show them on hover or focus. Dragging reorders items of the same kind.
 */
export function ComposerQueue({ chat, busy, running, onEdit }: ComposerQueueProps) {
    const root = useRootStore();
    const [dropped, setDropped] = useState<DroppedOrder>();
    // Rows with an in-flight send read `Steering…` while the daemon responds.
    const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
    const draggedRef = useRef(false);
    const queue = chat.queue;
    const items = dropped && dropped.base === queue ? dropped.items : (queue ?? []);

    if (items.length === 0) return null;

    // Compaction can only start once the orchestrator finishes.
    const compactWaits = running
        ? chat.queuePaused
            ? 'Send it once the agent finishes'
            : 'Runs when the agent finishes'
        : undefined;

    const reorder = async (next: QueuedMessage[], moved: QueuedMessage) => {
        const base = queue ?? [];

        setDropped({ base, items: next });

        // The daemon takes the place among the messages of the same kind.
        const index = next.filter(item => item.mode === moved.mode).findIndex(item => item.id === moved.id);
        const result = await perform(root, { type: 'chat.moveQueued', chatId: chat.id, itemId: moved.id, index });

        if (!result.ok) setDropped(current => (current?.base === base ? undefined : current));
    };

    const sendNow = async (item: QueuedMessage) => {
        setSending(current => new Set(current).add(item.id));
        await perform(root, { type: 'chat.sendQueued', chatId: chat.id, itemId: item.id });
        setSending(current => {
            const next = new Set(current);

            next.delete(item.id);

            return next;
        });
    };

    const edit = async (item: QueuedMessage) => {
        // The files go back to the project unsent, so the message box can send them again.
        const result = await perform(root, {
            type: 'chat.removeQueued',
            chatId: chat.id,
            itemId: item.id,
            keepFiles: true,
        });

        if (result.ok) onEdit(item);
    };

    const remove = (item: QueuedMessage) =>
        void perform(root, { type: 'chat.removeQueued', chatId: chat.id, itemId: item.id });

    const renderRow = (item: QueuedMessage, isFirst: boolean, isDragging: boolean) => {
        const steering = item.mode === 'steer' || sending.has(item.id);

        if (item.command === 'compact') {
            return (
                <CompactRow
                    label={queuedLabel(item)}
                    isFirst={isFirst}
                    sending={sending.has(item.id)}
                    waits={compactWaits}
                    onSendNow={() => void sendNow(item)}
                    onRemove={() => remove(item)}
                />
            );
        }

        if (item.from) {
            return (
                <ThreadItemRow
                    from={item.from}
                    label={queuedLabel(item)}
                    isFirst={isFirst}
                    steering={steering}
                    busy={busy}
                    onSendNow={() => void sendNow(item)}
                    onRemove={() => remove(item)}
                />
            );
        }

        return (
            <QueuedRow
                item={item}
                isFirst={isFirst}
                isDragging={isDragging}
                steering={steering}
                busy={busy}
                draggedRef={draggedRef}
                onSendNow={() => void sendNow(item)}
                onEdit={() => void edit(item)}
                onRemove={() => remove(item)}
            />
        );
    };

    return (
        <Scrollable vertical edgeFade className={styles.queue}>
            <Show when={chat.queuePaused}>
                {pause => (
                    <Text role="status" variant="xs" color="secondary" className={styles.paused}>
                        {`${PAUSED[pause]} Use the up arrow on a message to resume.`}
                    </Text>
                )}
            </Show>

            <SortableList
                aria-label="Queued messages"
                items={items}
                handle={false}
                gap="sm"
                className={styles.list}
                getKey={item => item.id}
                getTextValue={queuedLabel}
                // Steers and next turns do not mix.
                canDrop={({ items: [moving], target }) =>
                    moving !== undefined && (!target || target.mode === moving.mode)
                }
                onChange={(next, { item }) => void reorder(next, item)}
            >
                {(item, { isFirst, isDragging }) => renderRow(item, isFirst, isDragging)}
            </SortableList>
        </Scrollable>
    );
}

function SendQueuedButton({
    steer = false,
    waits,
    sending,
    onPress,
}: {
    steer?: boolean;
    waits?: string;
    sending?: boolean;
    onPress: () => void;
}) {
    const label = steer ? 'Steer' : 'Send now';

    return (
        <Unavailable label={label} hint={waits}>
            <Button
                iconOnly
                size="xs"
                variant="filling"
                color="secondary"
                aria-label={label}
                tooltip={waits ? undefined : label}
                isDisabled={waits !== undefined}
                isPending={sending}
                onPress={onPress}
            >
                <ArrowUp />
            </Button>
        </Unavailable>
    );
}

interface QueuedRowProps {
    item: QueuedMessage;
    isFirst: boolean;
    isDragging: boolean;
    /** The message waits for the agent's next step, or its send is in flight. */
    steering: boolean;
    busy: boolean;
    /** Set while a drag runs from this gesture, so the drop does not also open the message for editing. */
    draggedRef: RefObject<boolean>;
    onSendNow: () => void;
    onEdit: () => void;
    onRemove: () => void;
}

function QueuedRow({
    item,
    isFirst,
    isDragging,
    steering,
    busy,
    draggedRef,
    onSendNow,
    onEdit,
    onRemove,
}: QueuedRowProps) {
    const label = queuedLabel(item);
    const files = item.attachments?.length ?? 0;
    const hasText = item.text.trim() !== '';

    useEffect(() => {
        if (isDragging) draggedRef.current = true;
    }, [isDragging, draggedRef]);

    return (
        <div className={styles.item} data-first={isFirst || undefined}>
            <Pressable
                onPress={() => {
                    if (!draggedRef.current) onEdit();
                }}
            >
                <div
                    role="button"
                    tabIndex={0}
                    aria-label={`Edit: ${label}`}
                    aria-description={hasText && files > 0 ? `${filesLabel(files)} attached` : undefined}
                    className={styles.preview}
                    onPointerDown={() => {
                        draggedRef.current = false;
                    }}
                >
                    {files > 0 && <Clip className={styles.mark} aria-hidden />}
                    {hasText && <span className={styles.text}>{item.text}</span>}
                </div>
            </Pressable>

            <Show when={steering}>
                <span role="status" className={styles.status}>
                    Steering…
                </span>
            </Show>

            <Box direction="row" className={styles.actions}>
                {!steering && <SendQueuedButton steer={busy} onPress={onSendNow} />}
                <Button
                    iconOnly
                    size="xs"
                    variant="filling"
                    color="secondary"
                    aria-label="Edit"
                    tooltip="Edit"
                    onPress={onEdit}
                >
                    <EditPen />
                </Button>
                <Button
                    iconOnly
                    size="xs"
                    variant="filling"
                    color="secondary"
                    aria-label="Remove"
                    tooltip="Remove"
                    onPress={onRemove}
                >
                    <Trash />
                </Button>
            </Box>
        </div>
    );
}

interface ThreadItemRowProps {
    from: MessageSource;
    label: string;
    isFirst: boolean;
    /** It waits for the agent's next step, or its send is in flight. */
    steering: boolean;
    busy: boolean;
    onSendNow: () => void;
    onRemove: () => void;
}

/**
 * An item a thread sent while the orchestrator worked: threads that stopped (its one-line summary, `Thread "Fix login" finished`) or a thread's message.
 * The mark and the line, with the up arrow and Remove.
 */
function ThreadItemRow({ from, label, isFirst, steering, busy, onSendNow, onRemove }: ThreadItemRowProps) {
    return (
        <div className={styles.item} data-first={isFirst || undefined} data-thread>
            <div className={styles.preview} data-command>
                <span className={styles.mark} aria-hidden>
                    <ThreadRowMark from={from} />
                </span>
                <span className={styles.text}>{label}</span>
            </div>

            <Show when={steering}>
                <span role="status" className={styles.status}>
                    Steering…
                </span>
            </Show>

            <Box direction="row" className={styles.actions}>
                {!steering && <SendQueuedButton steer={busy} onPress={onSendNow} />}
                <Button
                    iconOnly
                    size="xs"
                    variant="filling"
                    color="secondary"
                    aria-label="Remove"
                    tooltip="Remove"
                    onPress={onRemove}
                >
                    <Trash />
                </Button>
            </Box>
        </div>
    );
}

/**
 * The mark that opens a thread's row, the same as on its card in the stream: the outcome of the threads that stopped (a check for a finished one, and for several the
 * worst of them), or the agent of the chat that wrote the message.
 */
function ThreadRowMark({ from }: { from: MessageSource }) {
    const project = useProjectState();

    if (from.kind === 'threadNotice') return <OutcomeMark outcome={worstOutcome(from.threads)} />;

    return <AgentMark engine={chatEngine(project.chats, project.runs, from.chatId)} />;
}

interface CompactRowProps {
    label: string;
    isFirst: boolean;
    /** Its Send now is with the daemon. */
    sending: boolean;
    /** Why Send now is off while the orchestrator has not finished: when the item will go. None once it can go now. */
    waits: string | undefined;
    onSendNow: () => void;
    onRemove: () => void;
}

/** A compact item: what it does, Send now once the orchestrator has finished (it cannot steer a turn), and Remove; there are no words to edit. */
function CompactRow({ label, isFirst, sending, waits, onSendNow, onRemove }: CompactRowProps) {
    return (
        <div className={styles.item} data-first={isFirst || undefined}>
            <div className={styles.preview} data-command>
                <Collapse className={styles.mark} aria-hidden />
                <span className={styles.text}>{label}</span>
            </div>

            <Box direction="row" className={styles.actions}>
                <SendQueuedButton waits={waits} sending={sending} onPress={onSendNow} />
                <Button
                    iconOnly
                    size="xs"
                    variant="filling"
                    color="secondary"
                    aria-label="Remove"
                    tooltip="Remove"
                    onPress={onRemove}
                >
                    <Trash />
                </Button>
            </Box>
        </div>
    );
}
