import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { Hotkey } from '@clowdy/components/Hotkey';
import { Menu, MenuItem, MenuSection, MenuSeparator, SubmenuTrigger } from '@clowdy/components/List';
import { PanelHeader } from '@clowdy/components/Panel';
import { Popover, PopoverScroll, PopoverTrigger, type UseContextMenuResult } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { ChevronRight } from '@clowdy/icons/8';
import { Check, Copy, EditPen, Eye, Folder, More, Page, Paste, Trash } from '@clowdy/icons/14';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';

import { folderOf, targetsOf, useExplorer } from './explorerContext';

import type { ReactNode } from 'react';
import type { NodeApi } from 'react-arborist';
import type { FileManager } from '../../FileManager';
import type { FileEntry, FileKind } from '../../provider';
import type { ExplorerItem } from './explorerContext';

/** An item a host adds to the explorer's row menus. */
export interface FileMenuItem {
    id: string;
    label: string;
    icon?: ReactNode;
    /** Put this item before the explorer's own actions, rather than after them. */
    placement?: 'first';
    /** A letter pressed with ⌘ (Ctrl off Mac) runs `onAction` on the focused row or selection, or while the menu is open. Shown beside the label. Not for an item with `children`. */
    hotkey?: string;
    onAction: () => void;
    /**
     * Items that open in a submenu beside this one. The item itself then does nothing when pressed (`onAction` is not called); the ids of the children are unique among
     * all the items of the menu, and a child has no ⌘ key of its own.
     */
    children?: FileMenuItem[];
}

const HOST_PREFIX = 'host:';

/** The items that run something: a submenu's children, in place of the submenu. */
function actionItems(items: readonly FileMenuItem[]): FileMenuItem[] {
    return items.flatMap(item => (item.children ? actionItems(item.children) : [item]));
}

/** A host's item: a row of the menu, or a row that opens a submenu with its children. */
function HostMenuItem({ item, onAction }: { item: FileMenuItem; onAction: (key: string) => void }) {
    if (item.children) {
        return (
            <SubmenuTrigger>
                <MenuItem
                    id={HOST_PREFIX + item.id}
                    icon={item.icon}
                    textValue={item.label}
                    endAffix={<ChevronRight />}
                >
                    {item.label}
                </MenuItem>
                <Popover spacing="xs">
                    <Menu aria-label={item.label} size="sm" onAction={key => onAction(String(key))}>
                        <For each={item.children}>
                            {child => <HostMenuItem key={child.id} item={child} onAction={onAction} />}
                        </For>
                    </Menu>
                </Popover>
            </SubmenuTrigger>
        );
    }

    return (
        <MenuItem
            id={HOST_PREFIX + item.id}
            icon={item.icon}
            textValue={item.label}
            endAffix={item.hotkey ? <Hotkey hotkey={['mod', item.hotkey]} /> : undefined}
        >
            {item.label}
        </MenuItem>
    );
}

function RowMenuContent({ targets, onClose }: { targets: readonly FileEntry[]; onClose: () => void }) {
    const explorer = useExplorer();
    const { manager } = explorer;
    const single = targets.length === 1 ? targets[0] : undefined;
    const hostItems = explorer.menuItems?.(targets) ?? [];

    const handleAction = (key: string) => {
        onClose();

        if (key.startsWith(HOST_PREFIX)) {
            actionItems(hostItems)
                .find(item => HOST_PREFIX + item.id === key)
                ?.onAction();

            return;
        }

        switch (key) {
            case 'new-file':
            case 'new-folder':
                explorer.create(single!.path, key === 'new-file' ? 'file' : 'directory');

                return;
            case 'rename':
                explorer.rename(single!.path);

                return;
            case 'copy':
                explorer.copy(targets.map(target => target.path));

                return;
            case 'paste':
                void manager.paste(folderOf(single!.path, single!.kind));

                return;
            case 'delete':
                explorer.delete(targets);
        }
    };

    return (
        <PopoverScroll>
            <Menu aria-label="File actions" size="sm" onAction={key => handleAction(String(key))}>
                <For each={hostItems.filter(item => item.placement === 'first')}>
                    {item => <HostMenuItem key={item.id} item={item} onAction={handleAction} />}
                </For>
                <Show when={!manager.readonly && single?.kind === 'directory'}>
                    <MenuSection>
                        <MenuItem id="new-file" icon={<Page />}>
                            New file
                        </MenuItem>
                        <MenuItem id="new-folder" icon={<Folder />}>
                            New folder
                        </MenuItem>
                    </MenuSection>
                    <MenuSeparator />
                </Show>
                <MenuSection>
                    <Show when={!manager.readonly && single}>
                        <MenuItem
                            id="rename"
                            icon={<EditPen />}
                            textValue="Rename"
                            endAffix={<Hotkey hotkey="enter" />}
                        >
                            Rename
                        </MenuItem>
                    </Show>
                    <Show when={manager.canCopy}>
                        <MenuItem
                            id="copy"
                            icon={<Copy />}
                            textValue="Copy"
                            endAffix={<Hotkey hotkey={['mod', 'c']} />}
                        >
                            Copy
                        </MenuItem>
                    </Show>
                    <Show when={manager.canPaste && single}>
                        <MenuItem
                            id="paste"
                            icon={<Paste />}
                            textValue="Paste"
                            endAffix={<Hotkey hotkey={['mod', 'v']} />}
                        >
                            Paste
                        </MenuItem>
                    </Show>
                    <For each={hostItems.filter(item => item.placement !== 'first')}>
                        {item => <HostMenuItem key={item.id} item={item} onAction={handleAction} />}
                    </For>
                </MenuSection>
                <Show when={!manager.readonly}>
                    <MenuSeparator />
                    <MenuSection>
                        <MenuItem
                            id="delete"
                            icon={<Trash />}
                            textValue="Delete"
                            isDanger
                            endAffix={<Hotkey hotkey="backspace" />}
                        >
                            Delete
                        </MenuItem>
                    </MenuSection>
                </Show>
            </Menu>
        </PopoverScroll>
    );
}

interface ExplorerMenuProps {
    node: NodeApi<ExplorerItem>;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    contextMenu: UseContextMenuResult;
}

/** A row's ⋯ menu and its right-click menu. Both act on the selection when the row is in it. */
export function ExplorerMenu({ node, isOpen, onOpenChange, contextMenu }: ExplorerMenuProps) {
    return (
        <>
            <PopoverTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
                <Button
                    variant="filling"
                    color="secondary"
                    size="xs"
                    iconOnly
                    aria-label="File actions"
                    preventFocusOnPress
                >
                    <More />
                </Button>
                <Popover placement="bottom end" spacing="xs">
                    <RowMenuContent targets={targetsOf(node)} onClose={() => onOpenChange(false)} />
                </Popover>
            </PopoverTrigger>
            <Show when={contextMenu.isOpen}>
                <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">
                    <RowMenuContent targets={targetsOf(node)} onClose={contextMenu.close} />
                </Popover>
            </Show>
        </>
    );
}

/**
 * The right-click menu of the empty area below the rows, or of a label row: new items and Paste in a folder, which is the explorer's root for the area and the root a
 * label heads for a label row.
 */
export function ExplorerAreaMenu({ contextMenu, folder }: { contextMenu: UseContextMenuResult; folder?: string }) {
    const { manager, root, create } = useExplorer();
    const target = folder ?? root;

    const handleAction = (key: string) => {
        contextMenu.close();

        if (key === 'paste') {
            void manager.paste(target);
        } else {
            create(target, key === 'new-file' ? 'file' : 'directory');
        }
    };

    return (
        <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">
            <PopoverScroll>
                <Menu aria-label="Files actions" size="sm" onAction={key => handleAction(String(key))}>
                    <MenuSection>
                        <MenuItem id="new-file" icon={<Page />}>
                            New file
                        </MenuItem>
                        <MenuItem id="new-folder" icon={<Folder />}>
                            New folder
                        </MenuItem>
                        <Show when={manager.canPaste}>
                            <MenuItem
                                id="paste"
                                icon={<Paste />}
                                textValue="Paste"
                                endAffix={<Hotkey hotkey={['mod', 'v']} />}
                            >
                                Paste
                            </MenuItem>
                        </Show>
                    </MenuSection>
                </Menu>
            </PopoverScroll>
        </Popover>
    );
}

interface ExplorerPanelMenuProps {
    manager: FileManager;
    /** Shows the inline new row where the selection is. */
    onCreate: (kind: FileKind) => void;
    /** Pastes where the selection is. */
    onPaste: () => void;
}

/** The Files panel's ⋯ menu in the panel header: new items, Paste, and "Show hidden files". */
export const ExplorerPanelMenu = observer(function ExplorerPanelMenu({
    manager,
    onCreate,
    onPaste,
}: ExplorerPanelMenuProps) {
    const { tree, readonly } = manager;
    const [isOpen, setOpen] = useState(false);

    const handleAction = (key: string) => {
        setOpen(false);

        if (key === 'show-hidden') {
            tree.setShowHidden(!tree.showHidden);
            // The filter keeps only shown files, so it runs again.
            void manager.filter(manager.filterQuery);

            return;
        }

        if (key === 'paste') {
            onPaste();

            return;
        }

        onCreate(key === 'new-file' ? 'file' : 'directory');
    };

    return (
        <PopoverTrigger isOpen={isOpen} onOpenChange={setOpen}>
            <PanelHeader.Button aria-label="Files actions" tooltip="Files actions">
                <More />
            </PanelHeader.Button>
            <Popover placement="bottom end" spacing="xs">
                <PopoverScroll>
                    <Menu aria-label="Files actions" size="sm" onAction={key => handleAction(String(key))}>
                        <Show when={!readonly}>
                            <MenuSection>
                                <MenuItem id="new-file" icon={<Page />}>
                                    New file
                                </MenuItem>
                                <MenuItem id="new-folder" icon={<Folder />}>
                                    New folder
                                </MenuItem>
                                <Show when={manager.canPaste}>
                                    <MenuItem
                                        id="paste"
                                        icon={<Paste />}
                                        textValue="Paste"
                                        endAffix={<Hotkey hotkey={['mod', 'v']} />}
                                    >
                                        Paste
                                    </MenuItem>
                                </Show>
                            </MenuSection>
                            <MenuSeparator />
                        </Show>
                        <MenuSection>
                            <MenuItem
                                id="show-hidden"
                                icon={<Eye />}
                                textValue="Show hidden files"
                                endAffix={tree.showHidden ? <Check /> : undefined}
                            >
                                Show hidden files
                            </MenuItem>
                        </MenuSection>
                    </Menu>
                </PopoverScroll>
            </Popover>
        </PopoverTrigger>
    );
});
