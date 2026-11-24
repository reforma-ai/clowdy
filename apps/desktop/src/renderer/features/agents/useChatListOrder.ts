import { useRef, useState } from 'react';

import { useProjectState, useProjectUi } from '../../stores';
import { folderById } from './agentTree';

import type { Chat, ChatId } from '@clowdy/protocol';
import type { DragEvent } from 'react';

const CHAT_DRAG_TYPE = 'application/x-clowdy-chat-order';
const CHAT_ROW = '[role="row"][data-depth]';
type Position = 'before' | 'after';

interface DropTarget {
    targetId: ChatId;
    indicatorId: ChatId;
    position: Position;
}

/** A drop on a thread goes after its root's entire block of visible rows. */
function targetAt(event: DragEvent): DropTarget | null {
    const row = (event.target as Element).closest<HTMLElement>(CHAT_ROW);

    if (!row || !event.currentTarget.contains(row)) return null;

    let root = row;

    while (root.dataset.depth !== '0') {
        const previous = root.previousElementSibling;

        if (!(previous instanceof HTMLElement) || !previous.matches(CHAT_ROW)) return null;

        root = previous;
    }

    const targetId = root.dataset.key;

    if (!targetId) return null;

    const box = root.getBoundingClientRect();

    if (row === root && event.clientY < box.top + box.height / 2) {
        return { targetId, indicatorId: targetId, position: 'before' };
    }

    let last = root;

    for (
        let next = last.nextElementSibling;
        next instanceof HTMLElement && next.matches(CHAT_ROW);
        next = last.nextElementSibling
    ) {
        if (next.dataset.depth === '0') break;

        last = next;
    }

    return { targetId, indicatorId: last.dataset.key ?? targetId, position: 'after' };
}

export function useChatListOrder(chats: readonly Chat[], visibleChatId?: ChatId) {
    const ui = useProjectUi();
    const project = useProjectState();
    const { folders } = project.project;
    const source = useRef<ChatId | null>(null);
    const [drop, setDrop] = useState<DropTarget | null>(null);

    const siblingsOf = (id: ChatId) => {
        const chat = chats.find(candidate => candidate.id === id);

        if (!chat) return [];
        if (!ui.groupByFolder) return chats;

        const folderId = folderById(folders, chat.folderId).id;

        return chats.filter(candidate => folderById(folders, candidate.folderId).id === folderId);
    };

    const move = (id: ChatId, targetId: ChatId, position: Position) => {
        const siblings = siblingsOf(id).map(chat => chat.id);
        const from = siblings.indexOf(id);
        const target = siblings.indexOf(targetId);

        if (target < 0 || from === target) return;

        const at = target + (position === 'after' ? 1 : 0) - (from < target ? 1 : 0);

        if (at === from) return;

        const inGroup = new Set(siblings);

        siblings.splice(from, 1);
        siblings.splice(at, 0, id);

        // Replace just these sibling slots so a move within one folder preserves the flat list's other folders.
        let index = 0;

        const visible = chats.map(chat => (inGroup.has(chat.id) ? siblings[index++] : chat.id));
        const current = new Set(visible);
        const saved = new Set(ui.chatOrder);
        // Keep the slots of archived chats so restoring one recovers its place.
        const slots = [...visible.filter(id => !saved.has(id)), ...ui.chatOrder.filter(id => project.chats.has(id))];
        let next = 0;

        ui.setChatOrder(
            slots.map(id => (current.has(id) ? visible[next++] : id)),
            visibleChatId
        );
    };

    const dropFor = (event: DragEvent) => {
        if (source.current === null || !event.dataTransfer.types.includes(CHAT_DRAG_TYPE)) return null;

        const target = targetAt(event);

        return target &&
            target.targetId !== source.current &&
            siblingsOf(source.current).some(chat => chat.id === target.targetId)
            ? target
            : null;
    };

    const end = () => {
        source.current = null;
        setDrop(null);
    };

    return {
        drop,
        start(event: DragEvent<HTMLElement>, id: ChatId) {
            source.current = id;
            event.dataTransfer.setData(CHAT_DRAG_TYPE, id);
            event.dataTransfer.effectAllowed = 'move';

            const row = event.currentTarget.closest<HTMLElement>(CHAT_ROW);

            if (row) {
                const box = row.getBoundingClientRect();

                event.dataTransfer.setDragImage(row, event.clientX - box.left, event.clientY - box.top);
            }
        },
        handlers: {
            onDragOver(event: DragEvent<HTMLDivElement>) {
                const target = dropFor(event);

                if (target) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                }

                setDrop(current =>
                    current?.indicatorId === target?.indicatorId && current?.position === target?.position
                        ? current
                        : target
                );
            },
            onDragLeave(event: DragEvent<HTMLDivElement>) {
                const next = event.relatedTarget;

                if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDrop(null);
            },
            onDrop(event: DragEvent<HTMLDivElement>) {
                const target = dropFor(event);

                if (target && source.current !== null) {
                    event.preventDefault();
                    move(source.current, target.targetId, target.position);
                }

                end();
            },
            onDragEnd: end,
        },
        actions(id: ChatId) {
            const siblings = siblingsOf(id);
            const index = siblings.findIndex(chat => chat.id === id);
            const before = siblings[index - 1];
            const after = index < 0 ? undefined : siblings[index + 1];

            return {
                onMoveUp: before ? () => move(id, before.id, 'before') : undefined,
                onMoveDown: after ? () => move(id, after.id, 'after') : undefined,
            };
        },
    };
}
