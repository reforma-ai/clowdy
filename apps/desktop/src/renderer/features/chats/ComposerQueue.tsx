import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { Pressable } from '@clowdy/components/Pressable';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Show } from '@clowdy/components/Show';
import { SortableList } from '@clowdy/components/SortableList';
import { Text } from '@clowdy/components/Text';
import { Clip, Collapse, EditPen, Trash } from '@clowdy/icons/14';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { useRootStore } from '../../stores';
import { perform } from './commands';
import styles from './ComposerQueue.module.css';
import { Unavailable } from './Unavailable';

import type { Chat, QueuedMessage, QueuePause } from '@clowdy/protocol';

const filesLabel = (count: number) => (count === 1 ? '1 file' : `${ count } files`);

/** What a row says of its message: the words, or the files when there are none. */
export function queuedLabel(item: QueuedMessage): string {
    const count = item.attachments?.length ?? 0;

    return item.text.trim() || (count > 0 ? filesLabel(count) : 'Queued message');
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
    /** The orchestrator works, so Send now steers its turn; at rest Send now sends the message as the next turn. */
    busy: boolean;
    /** The orchestrator has not finished (it works, or waits for its executors): a compact item cannot go yet. */
    running: boolean;
    /** The agent takes a message while it works (`canSteerChat`): a steer is read at once. One that does not leaves a steer waiting for the turn's end like any message. */
    canSteer: boolean;
    /** Send now stops the turn that runs and sends the message as the next one, because the agent cannot take it meanwhile (the daemon's stop and send). */
    stops: boolean;
    /** Edit: the message has left the queue, and its words and files go back into the message box. */
    onEdit: (item: QueuedMessage) => void;
}

/**
 * What waits for the orchestrator (`Chat.queue`), inside the composer above the text, as Reforma's queue: two lines of each message and its files, and
 * per message Send now, Edit and Remove (the head shows them at rest, the others on hover or focus). A steer says `Steering…` until the agent takes it.
 * For an agent that takes no steer (`canSteer`), Send now on a running turn reads `Stop and send`: the turn ends, and the message is the next one.
 * A compact item (Compact pressed while the agent worked) reads `Compact the conversation`, has nothing to edit, and its Send now waits until the
 * orchestrator has finished. A drag moves a message among those of its own kind. The queue is the daemon's: every change goes through it and comes
 * back with the chat.
 */
export function ComposerQueue({ chat, busy, running, canSteer, stops, onEdit }: ComposerQueueProps) {
    const root = useRootStore();
    const [dropped, setDropped] = useState<DroppedOrder>();
    // Send now presses still with the daemon: their rows read `Steering…` meanwhile.
    const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
    const draggedRef = useRef(false);
    const queue = chat.queue;
    const items = dropped && dropped.base === queue ? dropped.items : queue ?? [];

    if (items.length === 0) return null;

    // A compact item cannot steer, so its Send now waits for an orchestrator that has finished; a held queue gives it nothing by itself even then.
    const compactWaits = running ? (chat.queuePaused ? 'Send it once the agent finishes' : 'Runs when the agent finishes') : undefined;

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
        setSending((current) => {
            const next = new Set(current);

            next.delete(item.id);

            return next;
        });
    };

    const edit = async (item: QueuedMessage) => {
        // The files go back to the project unsent, so the message box can send them again.
        const result = await perform(root, { type: 'chat.removeQueued', chatId: chat.id, itemId: item.id, keepFiles: true });

        if (result.ok) onEdit(item);
    };

    const remove = (item: QueuedMessage) => void perform(root, { type: 'chat.removeQueued', chatId: chat.id, itemId: item.id });

    return (
        <Scrollable vertical edgeFade className={ styles.queue }>
            <Show when={ chat.queuePaused }>
                { pause => (
                    <Text role="status" variant="xs" color="secondary" className={ styles.paused }>
                        { `${ PAUSED[pause] } Use Send now on a message to resume.` }
                    </Text>
                ) }
            </Show>

            <SortableList
                aria-label="Queued messages"
                items={ items }
                handle={ false }
                gap="sm"
                className={ styles.list }
                getKey={ item => item.id }
                getTextValue={ queuedLabel }
                // Steers and next turns do not mix.
                canDrop={ ({ items: [moving], target }) => moving !== undefined && (!target || target.mode === moving.mode) }
                onChange={ (next, { item }) => void reorder(next, item) }
            >
                { (item, { isFirst, isDragging }) => (item.command === 'compact'
                    ? (
                        <CompactRow
                            label={ queuedLabel(item) }
                            isFirst={ isFirst }
                            sending={ sending.has(item.id) }
                            waits={ compactWaits }
                            onSendNow={ () => void sendNow(item) }
                            onRemove={ () => remove(item) }
                        />
                    )
                    : (
                        <QueuedRow
                            item={ item }
                            isFirst={ isFirst }
                            isDragging={ isDragging }
                            // A steer of an agent that cannot take one waits for the turn's end, so it is not "steering": it offers Send now like a message of the next turn.
                            steering={ (item.mode === 'steer' && canSteer) || sending.has(item.id) }
                            busy={ busy }
                            stops={ stops }
                            draggedRef={ draggedRef }
                            onSendNow={ () => void sendNow(item) }
                            onEdit={ () => void edit(item) }
                            onRemove={ () => remove(item) }
                        />
                    )) }
            </SortableList>
        </Scrollable>
    );
}

interface QueuedRowProps {
    item: QueuedMessage;
    isFirst: boolean;
    isDragging: boolean;
    /** The message waits for the agent's next step (a steer), or its Send now is on its way. */
    steering: boolean;
    busy: boolean;
    /** Send now stops the agent's turn first. */
    stops: boolean;
    /** Set while a drag runs from this gesture, so the drop does not also open the message for editing. */
    draggedRef: RefObject<boolean>;
    onSendNow: () => void;
    onEdit: () => void;
    onRemove: () => void;
}

function QueuedRow({ item, isFirst, isDragging, steering, busy, stops, draggedRef, onSendNow, onEdit, onRemove }: QueuedRowProps) {
    const label = queuedLabel(item);
    const files = item.attachments?.length ?? 0;

    useEffect(() => {
        if (isDragging) draggedRef.current = true;
    }, [isDragging, draggedRef]);

    return (
        <div className={ styles.item } data-first={ isFirst || undefined }>
            <Pressable
                onPress={ () => {
                    if (!draggedRef.current) onEdit();
                } }
            >
                <div
                    role="button"
                    tabIndex={ 0 }
                    aria-label={ `Edit: ${ label }` }
                    className={ styles.preview }
                    onPointerDown={ () => {
                        draggedRef.current = false;
                    } }
                >
                    <Show when={ item.text.trim() }>
                        <span className={ styles.text }>{ item.text }</span>
                    </Show>

                    <Show when={ files > 0 }>
                        <div className={ styles.files }>
                            <Clip />
                            <Text color="secondary">{ filesLabel(files) }</Text>
                        </div>
                    </Show>
                </div>
            </Pressable>

            <Show when={ steering }>
                <span role="status" className={ styles.status }>Steering…</span>
            </Show>

            <Box direction="row" className={ styles.actions }>
                <Show when={ !steering }>
                    <Button
                        size="xs"
                        variant="filling"
                        color="secondary"
                        tooltip={ stops ? 'Stops what the agent is doing now, then sends this message' : busy ? 'Submit without interrupting the model' : undefined }
                        onPress={ onSendNow }
                    >
                        { stops ? 'Stop and send' : 'Send now' }
                    </Button>
                </Show>
                <Button iconOnly size="xs" variant="filling" color="secondary" aria-label="Edit" tooltip="Edit" onPress={ onEdit }>
                    <EditPen />
                </Button>
                <Button iconOnly size="xs" variant="filling" color="secondary" aria-label="Remove" tooltip="Remove" onPress={ onRemove }>
                    <Trash />
                </Button>
            </Box>
        </div>
    );
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
        <div className={ styles.item } data-first={ isFirst || undefined }>
            <div className={ styles.preview } data-command>
                <span className={ styles.command }>
                    <Collapse aria-hidden />
                    <span className={ styles.text }>{ label }</span>
                </span>
            </div>

            <Box direction="row" className={ styles.actions }>
                <Unavailable label="Send now" hint={ waits }>
                    <Button size="xs" variant="filling" color="secondary" isDisabled={ waits !== undefined } isPending={ sending } onPress={ onSendNow }>
                        Send now
                    </Button>
                </Unavailable>
                <Button iconOnly size="xs" variant="filling" color="secondary" aria-label="Remove" tooltip="Remove" onPress={ onRemove }>
                    <Trash />
                </Button>
            </Box>
        </div>
    );
}
