import { DotsDrag } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import {
    DragDropProvider,
    DragOverlay,
    PointerSensor,
    useDroppable,
    type DragEndEvent,
} from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import { useCallback, useMemo, useState } from 'react';

import { For } from '../For';
import { Show } from '../Show';
import styles from './SortableList.module.css';
import {
    buildSortableTree,
    findSortableTreeNode,
    moveSortableTreeNodeToIndex,
    restoreSortableTree,
    type SortableTreeNode,
} from './sortableTree';

import type { ReactElement, ReactNode } from 'react';

export type SortableListDragHandleAlignment = 'center' | 'top';
export type SortableListDragHandleEdgeOffset = 'none' | 'sm' | 'md';
export type SortableListDragHandleVariant = 'plain' | 'surface';

export interface SortableListDragHandleOptions {
    alignment?: SortableListDragHandleAlignment;
    edgeOffset?: SortableListDragHandleEdgeOffset;
    variant?: SortableListDragHandleVariant;
}

export interface SortableListItemContext<T> {
    level: number;
    parent: T | null;
    index: number;
    siblingCount: number;
    isFirst: boolean;
    isLast: boolean;
    hasChildren: boolean;
    canHaveChildren: boolean;
}

export interface SortableListItemRenderProps<T> extends SortableListItemContext<T> {
    nestedItems: ReactNode;
    isDragging: boolean;
    isDropTarget: boolean;
}

export interface SortableListDropContext<T> {
    items: readonly T[];
    target: T | null;
    sourceParent: T | null;
    sourceLevel: number;
    parent: T | null;
    targetLevel: number;
    dropPosition: 'on' | 'before' | 'after' | 'end';
}

interface SortableListBaseProps<T> {
    items: readonly T[];
    getKey?: (item: T, path: readonly number[]) => string;
    getTextValue: (item: T) => string;
    /** `move` is the dragged item and its index among its new siblings. */
    onChange: (items: T[], move: { item: T; index: number }) => void;
    children: (item: T, props: SortableListItemRenderProps<T>) => ReactNode;
    canDrop?: (context: SortableListDropContext<T>) => boolean;
    getDragHandleOptions?: (
        item: T,
        context: SortableListItemContext<T>
    ) => SortableListDragHandleOptions;
    className?: string;
    gap?: 'sm' | 'md';
    nestedGap?: 'sm' | 'md';
    /** `false` drops the grip: the whole item starts a drag. Default `true`. */
    handle?: boolean;
    'aria-label': string;
}

interface FlatSortableListProps {
    getChildren?: never;
    setChildren?: never;
    canHaveChildren?: never;
}

interface NestedSortableListProps<T> {
    getChildren: (item: T) => readonly T[];
    setChildren: (item: T, children: T[]) => T;
    canHaveChildren?: (item: T) => boolean;
}

export type SortableListProps<T> = SortableListBaseProps<T>
  & (FlatSortableListProps | NestedSortableListProps<T>);

interface SortableNodeData<T> {
    kind: 'node';
    node: SortableTreeNode<T>;
}

interface SortableCollectionData<T> {
    kind: 'collection';
    parentNode: SortableTreeNode<T> | null;
}

interface SortableCollectionProps<T> {
    nodes: readonly SortableTreeNode<T>[];
    rootNodes: readonly SortableTreeNode<T>[];
    parentNode: SortableTreeNode<T> | null;
    renderItem: (item: T, props: SortableListItemRenderProps<T>) => ReactNode;
    canDrop?: (context: SortableListDropContext<T>) => boolean;
    getDragHandleOptions?: (
        item: T,
        context: SortableListItemContext<T>
    ) => SortableListDragHandleOptions;
    className?: string;
    gap: 'sm' | 'md';
    nestedGap: 'sm' | 'md';
    handle: boolean;
    ariaLabel: string;
}

interface SortableItemProps<T> extends Omit<SortableCollectionProps<T>, 'nodes' | 'className' | 'gap' | 'ariaLabel' | 'parentNode'> {
    node: SortableTreeNode<T>;
}

interface SortableDestination<T> {
    parentNode: SortableTreeNode<T> | null;
    index: number;
    dropPosition: 'before' | 'after' | 'end';
}

const ROOT_COLLECTION_ID = 'clowdy-sortable:root';
const CHILD_COLLECTION_PREFIX = 'clowdy-sortable:children:';
const SORTABLE_ITEM_TYPE = 'clowdy-sortable:item';
const SORTABLE_COLLECTION_TYPE = 'clowdy-sortable:collection';
const POINTER_SENSORS = [PointerSensor];
const PRIMITIVE_KEY_PREFIX = 'sortable:primitive:';

/** Keys for items without `getKey`: stable per object, unique across lists. */
const objectKeys = new WeakMap<object, string>();
let nextObjectKey = 0;

/**
 * Sortable collection with a pointer handle (or whole-item drag) and optional child groups.
 *
 * The rendered item is the complete draggable surface. Child collections can
 * accept moves when the caller's drop rules allow it.
 */
export function SortableList<T>({
    items,
    getKey: getItemKey,
    getTextValue,
    getChildren,
    setChildren,
    canHaveChildren,
    onChange,
    children,
    canDrop,
    getDragHandleOptions,
    className,
    gap = 'md',
    nestedGap = gap,
    handle = true,
    'aria-label': ariaLabel,
}: SortableListProps<T>) {
    const getNodeKey = useCallback((item: T, path: readonly number[]) => {
        const itemKey = getItemKey?.(item, path);

        if (itemKey != null) {
            return itemKey;
        }

        if (typeof item !== 'object' || item == null) {
            return `${ PRIMITIVE_KEY_PREFIX }${ path.join('.') }`;
        }

        const existingKey = objectKeys.get(item);

        if (existingKey) {
            return existingKey;
        }

        const key = `sortable:item:${ nextObjectKey }`;

        nextObjectKey += 1;
        objectKeys.set(item, key);

        return key;
    }, [getItemKey]);
    const nodes = useMemo(() => buildSortableTree(items, {
        getKey: getNodeKey,
        getTextValue,
        getChildren,
        canHaveChildren,
    }), [canHaveChildren, getChildren, getNodeKey, getTextValue, items]);
    const [renderState, setRenderState] = useState({ items, revision: 0 });

    if (renderState.items !== items) {
        setRenderState({ items, revision: renderState.revision + 1 });
    }

    function handleDragEnd(event: DragEndEvent) {
        const { canceled, operation } = event;
        const { source, target } = operation;

        if (canceled || !source || !isSortable(source)) {
            return;
        }

        const sourceNode = nodeData<T>(source)?.node;

        if (!sourceNode) {
            return;
        }

        const targetData = entityData<T>(target);
        const targetNode = targetData?.kind === 'node' ? targetData.node : null;
        let destination: SortableDestination<T> | null;

        if (targetData?.kind === 'collection') {
            destination = {
                parentNode: targetData.parentNode,
                index: targetData.parentNode?.children.length ?? nodes.length,
                dropPosition: 'end' as const,
            };
        }
        else if (targetNode
          && target
          && isSortable(target)) {
            destination = destinationFromSortable(
                nodes,
                target.group,
                source.index,
                targetNode
            );
        }
        else {
            destination = null;
        }

        if (!destination) {
            return;
        }

        const context = createDropContext(
            sourceNode,
            destination.parentNode,
            targetNode,
            destination.dropPosition
        );

        if (!canMoveToParent(sourceNode, destination.parentNode)
          || (canDrop && !canDrop(context))) {
            return;
        }

        const initialParentKey = parentKeyFromCollectionId(source.initialGroup);
        const destinationParentKey = destination.parentNode?.id ?? null;
        const isSamePosition = initialParentKey !== undefined
          && initialParentKey === destinationParentKey
          && source.initialIndex === destination.index;

        if (isSamePosition) {
            return;
        }

        const movedNodes = moveSortableTreeNodeToIndex(
            nodes,
            sourceNode.id,
            destinationParentKey,
            destination.index
        );

        onChange(restoreSortableTree(movedNodes, setChildren), {
            item: sourceNode.value,
            index: destination.index,
        });
    }

    return (
        <DragDropProvider
            // A cross-parent drop moves DOM nodes React does not own: remount nested trees on change.
            // Flat lists reconcile the optimistic order in place; a remount would cut the drop animation.
            key={ getChildren ? renderState.revision : undefined }
            sensors={ POINTER_SENSORS }
            onDragEnd={ handleDragEnd }
        >
            <SortableCollection
                nodes={ nodes }
                rootNodes={ nodes }
                parentNode={ null }
                renderItem={ children }
                canDrop={ canDrop }
                getDragHandleOptions={ getDragHandleOptions }
                className={ className }
                gap={ gap }
                nestedGap={ nestedGap }
                handle={ handle }
                ariaLabel={ ariaLabel }
            />

            <DragOverlay
                className={ styles.dragOverlay }
                dropAnimation={ {
                    duration: 160,
                    easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
                } }
            >
                { (source) => {
                    const node = nodeData<T>(source)?.node;

                    return node
                        ? (
                            <SortablePreview
                                node={ node }
                                renderItem={ children }
                                nestedGap={ nestedGap }
                            />
                        )
                        : null;
                } }
            </DragOverlay>
        </DragDropProvider>
    );
}

function SortableCollection<T>({
    nodes,
    rootNodes,
    parentNode,
    renderItem,
    canDrop,
    getDragHandleOptions,
    className,
    gap,
    nestedGap,
    handle,
    ariaLabel,
}: SortableCollectionProps<T>) {
    const { ref, isDropTarget } = useDroppable<SortableCollectionData<T>>({
        id: collectionId(parentNode),
        type: SORTABLE_COLLECTION_TYPE,
        data: { kind: 'collection', parentNode },
        disabled: nodes.length > 0,
        collisionPriority: 1,
        accept: source => canAcceptDrop(
            source,
            parentNode,
            null,
            'end',
            canDrop
        ),
    });

    return (
        <div
            ref={ ref }
            role="list"
            className={ cn(styles.list, className) }
            data-gap={ gap }
            data-drop-target={ isDropTarget || undefined }
            aria-label={ ariaLabel }
        >
            <For each={ nodes }>
                { node => (
                    <SortableItem
                        key={ node.id }
                        node={ node }
                        rootNodes={ rootNodes }
                        renderItem={ renderItem }
                        canDrop={ canDrop }
                        getDragHandleOptions={ getDragHandleOptions }
                        nestedGap={ nestedGap }
                        handle={ handle }
                    />
                ) }
            </For>
        </div>
    );
}

function SortableItem<T>({
    node,
    rootNodes,
    renderItem,
    canDrop,
    getDragHandleOptions,
    nestedGap,
    handle,
}: SortableItemProps<T>) {
    const context = itemContext(node);
    const {
        alignment = 'center',
        edgeOffset = 'none',
        variant = 'plain',
    } = getDragHandleOptions?.(node.value, context) ?? {};
    const {
        handleRef,
        ref,
        targetRef,
        isDragging,
        isDropTarget,
    } = useSortable<SortableNodeData<T>>({
        id: node.id,
        index: node.index,
        group: collectionIdFromParentKey(nodeParentKey(rootNodes, node)),
        type: SORTABLE_ITEM_TYPE,
        data: { kind: 'node', node },
        accept: source => canAcceptDrop(
            source,
            node.parent == null
                ? null
                : findParentNode(rootNodes, node),
            node,
            'before',
            canDrop
        ),
    });
    const nestedItems = node.canHaveChildren
        ? (
            <SortableCollection
                nodes={ node.children }
                rootNodes={ rootNodes }
                parentNode={ node }
                renderItem={ renderItem }
                canDrop={ canDrop }
                getDragHandleOptions={ getDragHandleOptions }
                gap={ nestedGap }
                nestedGap={ nestedGap }
                handle={ handle }
                ariaLabel={ `${ node.textValue } items` }
            />
        )
        : null;

    return (
        <div
            ref={ ref }
            role="listitem"
            className={ styles.item }
            data-level={ node.level }
            data-dragging={ isDragging || undefined }
            data-drop-target={ isDropTarget || undefined }
        >
            <div
                ref={ targetRef }
                className={ styles.dropTarget }
                data-container={ node.canHaveChildren || undefined }
                aria-hidden
            />

            <Show when={ handle }>
                <span
                    ref={ handleRef }
                    className={ styles.dragHandle }
                    data-alignment={ alignment }
                    data-edge-offset={ edgeOffset }
                    data-variant={ variant }
                    aria-hidden
                >
                    <DotsDrag aria-hidden width={ 14 } height={ 14 } />
                </span>
            </Show>

            <div className={ styles.content }>
                { renderItem(node.value, {
                    ...context,
                    nestedItems,
                    isDragging,
                    isDropTarget,
                }) }
            </div>
        </div>
    );
}

function SortablePreview<T>({
    node,
    renderItem,
    nestedGap,
}: {
    node: SortableTreeNode<T>;
    renderItem: (item: T, props: SortableListItemRenderProps<T>) => ReactNode;
    nestedGap: 'sm' | 'md';
}): ReactElement {
    const nestedItems = node.canHaveChildren
        ? (
            <div className={ styles.previewList } data-gap={ nestedGap }>
                <For each={ node.children }>
                    { child => (
                        <SortablePreview
                            key={ child.id }
                            node={ child }
                            renderItem={ renderItem }
                            nestedGap={ nestedGap }
                        />
                    ) }
                </For>
            </div>
        )
        : null;

    return (
        <div className={ styles.dragPreviewItem }>
            { renderItem(node.value, {
                ...itemContext(node),
                nestedItems,
                isDragging: false,
                isDropTarget: false,
            }) }
        </div>
    );
}

function itemContext<T>(node: SortableTreeNode<T>): SortableListItemContext<T> {
    return {
        level: node.level,
        parent: node.parent,
        index: node.index,
        siblingCount: node.siblingCount,
        isFirst: node.index === 0,
        isLast: node.index === node.siblingCount - 1,
        hasChildren: node.children.length > 0,
        canHaveChildren: node.canHaveChildren,
    };
}

function canAcceptDrop<T>(
    source: { data: Record<string, unknown> },
    parentNode: SortableTreeNode<T> | null,
    targetNode: SortableTreeNode<T> | null,
    dropPosition: SortableListDropContext<T>['dropPosition'],
    canDrop?: (context: SortableListDropContext<T>) => boolean
): boolean {
    const sourceNode = nodeData<T>(source)?.node;

    if (!sourceNode || !canMoveToParent(sourceNode, parentNode)) {
        return false;
    }

    return canDrop?.(
        createDropContext(sourceNode, parentNode, targetNode, dropPosition)
    ) ?? true;
}

function createDropContext<T>(
    sourceNode: SortableTreeNode<T>,
    parentNode: SortableTreeNode<T> | null,
    targetNode: SortableTreeNode<T> | null,
    dropPosition: SortableListDropContext<T>['dropPosition']
): SortableListDropContext<T> {
    return {
        items: [sourceNode.value],
        target: targetNode?.value ?? null,
        sourceParent: sourceNode.parent,
        sourceLevel: sourceNode.level,
        parent: parentNode?.value ?? null,
        targetLevel: parentNode ? parentNode.level + 1 : 1,
        dropPosition,
    };
}

function canMoveToParent<T>(
    sourceNode: SortableTreeNode<T>,
    parentNode: SortableTreeNode<T> | null
): boolean {
    return parentNode == null
      || (parentNode.id !== sourceNode.id
        && findSortableTreeNode(sourceNode.children, parentNode.id) == null);
}

function destinationFromSortable<T>(
    nodes: readonly SortableTreeNode<T>[],
    group: string | number | undefined,
    index: number,
    targetNode: SortableTreeNode<T> | null
): SortableDestination<T> | null {
    const parentKey = parentKeyFromCollectionId(group);

    if (parentKey === undefined) {
        return null;
    }

    const parentNode = parentKey == null
        ? null
        : findSortableTreeNode(nodes, parentKey);

    if (parentKey != null && !parentNode) {
        return null;
    }

    const isAfterTarget = targetNode != null && index > targetNode.index;

    return {
        parentNode,
        index,
        dropPosition: isAfterTarget ? 'after' : 'before',
    };
}

function collectionId<T>(parentNode: SortableTreeNode<T> | null): string {
    return collectionIdFromParentKey(parentNode?.id ?? null);
}

function collectionIdFromParentKey(parentKey: string | null): string {
    return parentKey == null
        ? ROOT_COLLECTION_ID
        : `${ CHILD_COLLECTION_PREFIX }${ parentKey }`;
}

function parentKeyFromCollectionId(
    collectionId: string | number | undefined
): string | null | undefined {
    if (collectionId === ROOT_COLLECTION_ID) {
        return null;
    }

    if (typeof collectionId === 'string'
      && collectionId.startsWith(CHILD_COLLECTION_PREFIX)) {
        return collectionId.slice(CHILD_COLLECTION_PREFIX.length);
    }

    return undefined;
}

function nodeParentKey<T>(
    nodes: readonly SortableTreeNode<T>[],
    target: SortableTreeNode<T>
): string | null {
    return findParentNode(nodes, target)?.id ?? null;
}

function findParentNode<T>(
    nodes: readonly SortableTreeNode<T>[],
    target: SortableTreeNode<T>
): SortableTreeNode<T> | null {
    for (const node of nodes) {
        if (node.children.some(child => child.id === target.id)) {
            return node;
        }

        const parent = findParentNode(node.children, target);

        if (parent) {
            return parent;
        }
    }

    return null;
}

function entityData<T>(
    entity: { data: Record<string, unknown> } | null
): SortableNodeData<T> | SortableCollectionData<T> | null {
    const data = entity?.data;

    if (data?.kind === 'node' && 'node' in data) {
        return {
            kind: 'node',
            node: data.node as SortableTreeNode<T>,
        };
    }

    if (data?.kind === 'collection' && 'parentNode' in data) {
        return {
            kind: 'collection',
            parentNode: data.parentNode as SortableTreeNode<T> | null,
        };
    }

    return null;
}

function nodeData<T>(
    entity: { data: Record<string, unknown> } | null
): SortableNodeData<T> | null {
    const data = entityData<T>(entity);

    return data?.kind === 'node' ? data : null;
}

SortableList.displayName = 'SortableList';
