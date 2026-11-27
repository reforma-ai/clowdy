import { useEffect, useRef, useState } from 'react';

import { useProjectState, useProjectUi } from '../../stores';
import { folderById } from './agentTree';
import { chatWorktreeKey, type WorktreeCard } from './worktreeCards';

import type { Chat, ChatId } from '@clowdy/protocol';
import type { DragEvent } from 'react';

const CHAT_DRAG_TYPE = 'application/x-clowdy-chat-order';
const CARD_DRAG_TYPE = 'application/x-clowdy-worktree-order';
const CHAT_ROW = '[role="row"][data-depth]';
type Position = 'before' | 'after';

interface Block {
    id: string;
    elements: HTMLElement[];
    top: number;
    bottom: number;
    middle: number;
    left: number;
    right: number;
    extent: number;
}

interface Preview {
    container: HTMLElement;
    blocks: Block[];
}

function clearPreview(preview: Preview | null, committed = false) {
    for (const block of preview?.blocks ?? []) {
        for (const element of block.elements) {
            // React will place these nodes at their new positions on a successful
            // drop. Do not animate the old offset against that new layout.
            if (committed) element.style.transition = 'none';
            element.style.removeProperty('--reorder-offset');
            delete element.dataset.reorderSource;
            if (committed) requestAnimationFrame(() => element.style.removeProperty('transition'));
        }
    }
}

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

export function useChatListOrder(
    chats: readonly Chat[],
    visibleChatId?: ChatId,
    cards: readonly WorktreeCard[] = [],
    shownCards: readonly WorktreeCard[] = cards
) {
    const ui = useProjectUi();
    const project = useProjectState();
    const { folders } = project.project;
    const source = useRef<ChatId | null>(null);
    const [drop, setDrop] = useState<DropTarget | null>(null);
    const preview = useRef<Preview | null>(null);
    useEffect(() => () => clearPreview(preview.current), []);

    const siblingsOf = (id: ChatId) => {
        const chat = chats.find(candidate => candidate.id === id);

        if (!chat) return [];
        const workspace = ui.groupByWorktree
            ? (chatWorktreeKey(chat, cards) ?? cards.find(card => card.main && card.roots.includes(chat))?.key)
            : undefined;
        if (workspace)
            return chats.filter(
                candidate =>
                    (chatWorktreeKey(candidate, cards) ??
                        cards.find(card => card.main && card.roots.includes(candidate))?.key) === workspace
            );

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
        const card = shownCards.find(candidate => candidate.key === id);
        return card && !card.main
            ? shownCards.filter(candidate => !candidate.main && candidate.folder.id === card.folder.id)
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
        const aliases = new Map(
            cards.flatMap(card => (card.orderAliases ?? []).map(alias => [alias, card.key] as const))
        );
        const saved = [...new Set(ui.worktreeOrder.map(key => aliases.get(key) ?? key))];
        const known = new Set(saved);
        const slots = [...saved, ...cards.map(card => card.key).filter(key => !known.has(key))];
        let index = 0;
        const moved = slots.map(key => (inGroup.has(key) ? siblings[index++] : key));
        ui.markWorktreesMoved(
            cards
                .filter(card => card.key === id || card.key === targetId)
                .flatMap(card => [card.key, ...(card.orderAliases ?? [])])
        );
        ui.setWorktreeOrder([
            ...new Set(moved.flatMap(key => [key, ...(cards.find(card => card.key === key)?.orderAliases ?? [])])),
        ]);
    };

    // Measure in the list's coordinate space before applying transforms, so hit testing
    // does not follow the animated rows and remains stable while the list scrolls.
    const measure = (container: HTMLElement, cardDrag: boolean): Preview | null => {
        if (!source.current) return null;
        const ids = new Set(
            cardDrag
                ? cardSiblings(source.current).map(card => card.key)
                : siblingsOf(source.current).map(chat => chat.id)
        );
        const selector = cardDrag ? '[data-worktree-card]' : `${CHAT_ROW}[data-depth="0"]`;
        const roots = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(element =>
            ids.has((cardDrag ? element.dataset.worktreeCard : element.dataset.key) ?? '')
        );
        const sourceElement = roots.find(
            element => (cardDrag ? element.dataset.worktreeCard : element.dataset.key) === source.current
        );
        if (!sourceElement) return null;
        // Only siblings sharing a collection may move together.
        const siblings = roots.filter(element => element.parentElement === sourceElement.parentElement);
        const origin = container.getBoundingClientRect();
        const blocks = siblings.map(element => {
            const elements = [element];
            if (!cardDrag) {
                for (
                    let next = element.nextElementSibling;
                    next instanceof HTMLElement && next.matches(CHAT_ROW) && next.dataset.depth !== '0';
                    next = next.nextElementSibling
                )
                    elements.push(next);
            }
            const box = element.getBoundingClientRect();
            const last = elements[elements.length - 1]!.getBoundingClientRect();
            return {
                id: (cardDrag ? element.dataset.worktreeCard : element.dataset.key)!,
                elements,
                top: box.top - origin.top,
                bottom: last.bottom - origin.top,
                middle: box.top - origin.top + box.height / 2,
                left: box.left - origin.left,
                right: box.right - origin.left,
                extent: last.bottom - box.top,
            };
        });
        for (let i = 0; i < blocks.length - 1; i++) blocks[i]!.extent = blocks[i + 1]!.top - blocks[i]!.top;
        if (blocks.length > 1) {
            const previous = blocks[blocks.length - 2]!;
            const last = blocks[blocks.length - 1]!;
            // The list gap (and card margins) belongs to every moved unit,
            // including the last one, which has no following top to measure.
            last.extent += previous.extent - (previous.bottom - previous.top);
        }
        return blocks.some(block => block.extent <= 0) ? null : { container, blocks };
    };

    const previewTarget = (event: DragEvent, snapshot: Preview): DropTarget | null => {
        const origin = snapshot.container.getBoundingClientRect();
        const x = event.clientX - origin.left;
        const y = event.clientY - origin.top;
        const block = snapshot.blocks.find(
            block => x >= block.left && x <= block.right && y >= block.top && y <= block.bottom
        );
        if (!block || block.id === source.current) return null;
        return { targetId: block.id, indicatorId: block.id, position: y < block.middle ? 'before' : 'after' };
    };

    const showPreview = (snapshot: Preview, target: DropTarget | null) => {
        const blocks = snapshot.blocks;
        const from = blocks.findIndex(block => block.id === source.current);
        const to = blocks.findIndex(block => block.id === target?.targetId);
        if (from < 0) return;
        const ordered = [...blocks];
        const [moving] = ordered.splice(from, 1);
        const at = target && to >= 0 ? to + (target.position === 'after' ? 1 : 0) - (from < to ? 1 : 0) : from;
        ordered.splice(at, 0, moving!);
        let top = blocks[0]!.top;
        for (const block of ordered) {
            for (const element of block.elements) {
                element.style.setProperty('--reorder-offset', `${top - block.top}px`);
                if (block.id === source.current) element.dataset.reorderSource = '';
            }
            top += block.extent;
        }
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

    const end = (committed = false) => {
        clearPreview(preview.current, committed);
        preview.current = null;
        source.current = null;
        setDrop(null);
    };

    return {
        drop,
        startCard(event: DragEvent<HTMLElement>, key: string) {
            source.current = key;
            event.dataTransfer.setData(CARD_DRAG_TYPE, key);
            event.dataTransfer.effectAllowed = 'move';

            const card = event.currentTarget.closest<HTMLElement>('[data-worktree-card]');
            if (card) {
                const box = card.getBoundingClientRect();
                event.dataTransfer.setDragImage(card, event.clientX - box.left, event.clientY - box.top);
            }
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
                const isCard = event.dataTransfer.types.includes(CARD_DRAG_TYPE);
                const isChat = event.dataTransfer.types.includes(CHAT_DRAG_TYPE);
                if (source.current && (isCard || isChat)) preview.current ??= measure(event.currentTarget, isCard);
                const target = preview.current ? previewTarget(event, preview.current) : dropFor(event);
                if (preview.current) showPreview(preview.current, target);

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
                const box = event.currentTarget.getBoundingClientRect();
                const inside =
                    event.clientX >= box.left &&
                    event.clientX <= box.right &&
                    event.clientY >= box.top &&
                    event.clientY <= box.bottom;

                if (!(next instanceof Node && event.currentTarget.contains(next)) && !inside) {
                    if (preview.current) showPreview(preview.current, null);
                    setDrop(null);
                }
            },
            onDrop(event: DragEvent<HTMLDivElement>) {
                const target = preview.current ? previewTarget(event, preview.current) : dropFor(event);

                if (target && source.current !== null) {
                    event.preventDefault();
                    if (event.dataTransfer.types.includes(CARD_DRAG_TYPE))
                        moveCard(source.current, target.targetId, target.position);
                    else move(source.current, target.targetId, target.position);
                }

                end(Boolean(target));
            },
            onDragEnd: () => end(),
        },
    };
}
