import { FileIcon } from '@clowdy/components/FileIcon';
import { Input } from '@clowdy/components/Input';
import { TreeChevron } from '@clowdy/components/Panel';
import { Popover, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { basename, dirname, isPathWithin } from '../../paths';
import styles from './Explorer.module.css';
import { ExplorerAreaMenu, ExplorerMenu } from './ExplorerMenu';
import { DRAFT_ID, folderOfNode, hotkeyItem, targetsOf, useExplorer } from './explorerContext';

import type { SyntheticEvent } from 'react';
import type { DragPreviewProps, NodeApi, NodeRendererProps, RowRendererProps } from 'react-arborist';
import type { ExplorerItem } from './explorerContext';

/** Space before the icon of a top-level row; the chevron hangs into it. */
const ROW_PADDING = 22;

function stopPropagation(event: SyntheticEvent) {
    event.stopPropagation();
}

/**
 * The row element react-arborist positions: its default, but only as wide as the list, so long names
 * truncate. It names the folder that files dropped on it go in.
 */
export function ExplorerRowFrame({ node, attrs, innerRef, children }: RowRendererProps<ExplorerItem>) {
    const { draftParent } = useExplorer();

    // A label row is not an item of the tree: no role, no selection, no click that selects it. Files dropped on it go in the root it heads.
    if (node.data.heading !== undefined) {
        return (
            <div
                ref={innerRef}
                role="presentation"
                style={{ ...attrs.style, minWidth: 0, width: '100%' }}
                data-heading=""
                data-folder={node.data.heading}
                onFocus={stopPropagation}
            >
                {children}
            </div>
        );
    }

    return (
        <div
            {...attrs}
            ref={innerRef}
            style={{ ...attrs.style, minWidth: 0, width: '100%' }}
            data-folder={node.id === DRAFT_ID ? draftParent : folderOfNode(node)}
            onFocus={stopPropagation}
            onClick={node.handleClick}
        >
            {children}
        </div>
    );
}

/** What follows the pointer while rows are dragged: the row's icon and name, or how many rows. */
export function ExplorerDragPreview({ mouse, id, dragIds, isDragging }: DragPreviewProps) {
    const { manager } = useExplorer();
    // The drag layer also reports drags from other trees on a shared manager; those name no listed path.
    const entry = id === null ? undefined : manager.tree.get(id);

    if (!isDragging || !mouse || !entry) {
        return null;
    }

    // On the body: a host panel's transform would move a fixed element and its stacking would hide it.
    return createPortal(
        <div className={styles.dragPreview} style={{ translate: `${mouse.x + 12}px ${mouse.y + 8}px` }}>
            <FileIcon path={entry.path} kind={entry.kind} />
            {dragIds.length > 1 ? `${dragIds.length} items` : basename(entry.path)}
        </div>,
        document.body
    );
}

/** The inline name input of a rename or a new row. Enter or leaving it applies a valid name; Escape cancels. */
function NameInput({ node, onValueChange }: { node: NodeApi<ExplorerItem>; onValueChange?: (value: string) => void }) {
    const { manager, draftParent, fileName } = useExplorer();
    const { kind, name } = node.data;
    const draft = node.id === DRAFT_ID;
    const [value, setValue] = useState(name);
    const finished = useRef(false);
    const input = useRef<HTMLInputElement>(null);
    const field = useRef<HTMLSpanElement>(null);
    // A scope can complete a file's name (`.md` for a document): the name is checked, and applied, as it will be.
    const typed = kind === 'file' && fileName && value.trim() !== '' ? fileName(value.trim()) : value.trim();
    const unchanged = typed === '' || (!draft && typed === name);
    const problem = unchanged
        ? null
        : manager.operations.validateName(
              draft ? (draftParent ?? '') : dirname(node.id),
              typed,
              draft ? undefined : node.id
          );

    const finish = (apply: boolean) => {
        if (finished.current) {
            return;
        }

        finished.current = true;

        if (apply && !unchanged && !problem) {
            node.submit(typed);
        } else {
            node.reset();
        }
    };

    // Focus with the name selected up to its extension, as VS Code does.
    useLayoutEffect(() => {
        const element = input.current;

        if (!element) {
            return;
        }

        const dot = kind === 'file' ? element.value.lastIndexOf('.') : -1;

        element.focus();
        element.setSelectionRange(0, dot > 0 ? dot : element.value.length);
    }, [kind]);

    // Clicks stay in the field instead of selecting or toggling the row.
    return (
        <span ref={field} className={styles.nameField} onClick={stopPropagation} onDoubleClick={stopPropagation}>
            <Input
                type="text"
                size="xs"
                variant="inline"
                inputRef={input}
                value={value}
                spellCheck={false}
                aria-label={draft ? `New ${kind === 'file' ? 'file' : 'folder'} name` : `Rename ${name}`}
                isInvalid={problem !== null}
                onChange={next => {
                    setValue(next);
                    onValueChange?.(next);
                }}
                onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== 'Escape') {
                        return;
                    }

                    event.preventDefault();
                    event.stopPropagation();

                    if (event.key === 'Escape') {
                        finish(false);
                    } else if (!problem) {
                        finish(true);
                    }
                }}
                onBlur={() => finish(true)}
            />
            <Show when={problem}>
                {message => (
                    // Beside the field, over the editor: the list scrolls, so it would clip the message and the next row would cover it.
                    <Popover triggerRef={field} isOpen isNonModal placement="right top" className={styles.nameProblem}>
                        <div role="alert">{message}</div>
                    </Popover>
                )}
            </Show>
        </span>
    );
}

/** The gray label that heads a root of a scope. Its right-click menu makes new items and pastes in the root it heads. */
function ExplorerHeading({ name, folder }: { name: string; folder: string }) {
    const contextMenu = useContextMenu();
    const { manager } = useExplorer();

    return (
        <div
            className={styles.heading}
            onContextMenu={event => {
                if (!manager.readonly) {
                    contextMenu.areaProps.onContextMenu(event);
                }
            }}
        >
            <span className={styles.headingName}>{name}</span>
            <Show when={contextMenu.isOpen}>
                <ExplorerAreaMenu contextMenu={contextMenu} folder={folder} />
            </Show>
        </div>
    );
}

/** One explorer row: a label row of a scope, or a row of the tree. */
export function ExplorerRow(props: NodeRendererProps<ExplorerItem>) {
    const { heading, name } = props.node.data;

    return heading === undefined ? <ExplorerEntryRow {...props} /> : <ExplorerHeading name={name} folder={heading} />;
}

/** One row of the tree: chevron, icon, name or its input, and the ⋯ menu shown on hover. */
function ExplorerEntryRow({ node, dragHandle }: NodeRendererProps<ExplorerItem>) {
    const [menuOpen, setMenuOpen] = useState(false);
    const contextMenu = useContextMenu();
    const { manager, root, dropFolder, menuItems, onEntryDragStart } = useExplorer();
    const { kind, name } = node.data;
    const draft = node.id === DRAFT_ID;
    // The tree shows a hidden path only while "Show hidden files" is on, and draws it fainter so it still reads as one. A scope's rows are shown by its own rules.
    const hidden = !draft && root === '' && manager.tree.isHidden(node.id);
    // A new row has no path yet, so its icon follows the name being typed.
    const [draftName, setDraftName] = useState('');
    const iconPath = draft ? draftName.trim() || node.id : node.id;
    // A row drag, or files from outside; a drop on the root marks the whole tree instead.
    const destination = node.tree.state.nodes.drag.destinationParentId ?? (dropFolder || null);
    // Neighbors with the same fill join into one plate; a drop target paints over the selection.
    const fill = (row: NodeApi<ExplorerItem> | null) => {
        if (row && destination !== null && isPathWithin(row.id, destination)) {
            return 'drop';
        }

        return row?.isSelected ? 'selected' : null;
    };
    const ownFill = fill(node);

    return (
        <div
            ref={dragHandle}
            style={{ paddingLeft: ROW_PADDING + node.level * node.tree.indent }}
            className={styles.row}
            data-selected={node.isSelected || undefined}
            data-sole-selected={(node.isSelected && node.tree.hasOneSelection) || undefined}
            data-editing={node.isEditing || undefined}
            data-hidden={hidden || undefined}
            data-drop-target={ownFill === 'drop' || undefined}
            data-joined-start={(ownFill && fill(node.prev) === ownFill) || undefined}
            data-joined-end={(ownFill && fill(node.next) === ownFill) || undefined}
            data-open={menuOpen || contextMenu.isOpen || undefined}
            onDragStartCapture={event => {
                if (!draft && !node.isEditing && event.target === event.currentTarget) {
                    onEntryDragStart?.(targetsOf(node), event.dataTransfer);
                }
            }}
            onClick={event => {
                // The row frame selects; a plain click also opens or closes a folder.
                if (node.isInternal && !draft && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                    node.toggle();
                }
            }}
            onContextMenu={event => {
                if (!draft) {
                    setMenuOpen(false);
                    contextMenu.areaProps.onContextMenu(event);
                }
            }}
        >
            <span className={styles.toggleArea}>
                <Show when={node.isInternal}>
                    <TreeChevron isOpen={node.isOpen} onToggle={() => node.toggle()} />
                </Show>
                <FileIcon path={iconPath} kind={kind} open={node.isOpen} className={styles.icon} />
            </span>
            <Show when={node.isEditing} fallback={<span className={styles.name}>{name}</span>}>
                <NameInput node={node} onValueChange={draft ? setDraftName : undefined} />
            </Show>
            <Show when={!draft && !node.isEditing}>
                <div
                    className={styles.actions}
                    onClick={stopPropagation}
                    onDoubleClick={stopPropagation}
                    onPointerDown={stopPropagation}
                    onKeyDown={event => {
                        event.stopPropagation();

                        // A host item's hotkey also works from the ⋯ button and its open menu, where the tree's keys do not reach.
                        const item = hotkeyItem(menuItems?.(targetsOf(node)) ?? [], event);

                        if (item) {
                            event.preventDefault();
                            setMenuOpen(false);
                            contextMenu.close();
                            item.onAction();
                        }
                    }}
                >
                    <ExplorerMenu
                        node={node}
                        isOpen={menuOpen}
                        onOpenChange={open => {
                            if (open) {
                                contextMenu.close();
                            }

                            setMenuOpen(open);
                        }}
                        contextMenu={contextMenu}
                    />
                </div>
            </Show>
        </div>
    );
}
