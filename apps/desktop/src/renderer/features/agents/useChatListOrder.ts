import { useRef, useState } from 'react';

import { useProjectState, useProjectUi } from '../../stores';
import { folderById } from './agentTree';
import { chatWorktreeKey, type WorktreeCard } from './worktreeCards';

import type { Chat, ChatId } from '@clowdy/protocol';
import type { DragEvent } from 'react';

const CHAT_DRAG_TYPE = 'application/x-clowdy-chat-order';
const CARD_DRAG_TYPE = 'application/x-clowdy-worktree-order';
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

export function useChatListOrder(chats: readonly Chat[], visibleChatId?: ChatId, cards: readonly WorktreeCard[] = []) {
    const ui = useProjectUi();
    const project = useProjectState();
    const { folders } = project.project;
    const source = useRef<ChatId | null>(null);
    const [drop, setDrop] = useState<DropTarget | null>(null);

    const siblingsOf = (id: ChatId) => {
        const chat = chats.find(candidate => candidate.id === id);

        if (!chat) return [];
        const workspace = ui.groupByWorktree ? chatWorktreeKey(chat, cards) : undefined;
        if (workspace) return chats.filter(candidate => chatWorktreeKey(candidate, cards) === workspace);

        const folderId = folderById(folders, chat.folderId).id;
        return chats.filter(
            candidate =>
                (!ui.groupByFolder || folderById(folders, candidate.folderId).id === folderId) &&
                (!ui.groupByWorktree || candidate.workspace === undefined)
        );
    };

    const move = (id: ChatId, targetId: ChatId, position: Position) => {
        const siblings = siblingsOf(id).map(chat => chat.id);
        const from = siblings.indexOf(id);
        const target = siblings.indexOf(targetId);

        if (from < 0 || target < 0 || from === target) return;

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

    const cardSiblings = (id: string) => {
        const card = cards.find(candidate => candidate.key === id);
        return card
            ? cards.filter(
                  candidate =>
                      candidate.used === card.used && (!ui.groupByFolder || candidate.folder.id === card.folder.id)
              )
            : [];
    };

    const moveCard = (id: string, targetId: string, position: Position) => {
        const siblings = cardSiblings(id).map(card => card.key);
        const from = siblings.indexOf(id);
        const to = siblings.indexOf(targetId);
        if (from < 0 || to < 0 || from === to) return;
        const inGroup = new Set(siblings);
        siblings.splice(from, 1);
        siblings.splice(to + (position === 'after' ? 1 : 0) - (from < to ? 1 : 0), 0, id);
        const known = new Set(ui.worktreeOrder);
        const slots = [...ui.worktreeOrder, ...cards.map(card => card.key).filter(key => !known.has(key))];
        let index = 0;
        ui.setWorktreeOrder(slots.map(key => (inGroup.has(key) ? siblings[index++] : key)));
    };

    const dropFor = (event: DragEvent) => {
        if (source.current !== null && event.dataTransfer.types.includes(CARD_DRAG_TYPE)) {
            const card = (event.target as Element).closest<HTMLElement>('[data-worktree-card]');
            const targetId = card?.dataset.worktreeCard;
            if (
                !card ||
                !targetId ||
                targetId === source.current ||
                !cardSiblings(source.current).some(candidate => candidate.key === targetId)
            )
                return null;
            const box = card.getBoundingClientRect();
            return {
                targetId,
                indicatorId: targetId,
                position: event.clientY < box.top + box.height / 2 ? ('before' as const) : ('after' as const),
            };
        }
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
        startCard(event: DragEvent<HTMLElement>, key: string) {
            source.current = key;
            event.dataTransfer.setData(CARD_DRAG_TYPE, key);
            event.dataTransfer.effectAllowed = 'move';
        },
        cardActions(id: string) {
            const siblings = cardSiblings(id);
            const index = siblings.findIndex(card => card.key === id);
            const before = siblings[index - 1];
            const after = index < 0 ? undefined : siblings[index + 1];
            return {
                onMoveUp: before ? () => moveCard(id, before.key, 'before') : undefined,
                onMoveDown: after ? () => moveCard(id, after.key, 'after') : undefined,
            };
        },
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
                    if (event.dataTransfer.types.includes(CARD_DRAG_TYPE))
                        moveCard(source.current, target.targetId, target.position);
                    else move(source.current, target.targetId, target.position);
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
