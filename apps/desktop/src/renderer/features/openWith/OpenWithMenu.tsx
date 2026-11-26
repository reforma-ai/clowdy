import { For } from '@clowdy/components/For';
import { Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator, SubmenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { toast } from '@clowdy/components/Toast';
import { ChevronRight } from '@clowdy/icons/8';
import { Close, Copy, Folder, Follow, NewChat, Search, Settings, Terminal } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { openInFiles } from '../files/openInFiles';
import { currentPlace, isPlaceReady, isSamePlace, placeOf } from '../sidePanel/currentPlace';
import { openInTerminal } from '../terminal/openInTerminal';
import { AppIcon } from './AppIcon';
import { chosenPrograms, openEffects, useOpenApps } from './openApps';
import { type FolderGit, type OpenAction, type OpenTarget, openActions } from './openTarget';

import type { ReactNode } from 'react';
import type { FolderRepair } from './useFolderRepair';

/** An item of the caller's own, which the menu draws under a separator after its own (`Discard changes…` on a changed file). */
export interface OpenMenuExtra {
    id: string;
    label: string;
    icon: ReactNode;
    isDanger?: boolean;
    run: () => void;
}

export interface OpenWithMenuProps {
    target: OpenTarget;
    /** The folder is gone from the disk: what needs it is off, and the menu says so. */
    missing?: boolean;
    /** For a folder that is gone: Locate… and Remove from project, under the note (`useFolderRepair`). */
    repair?: FolderRepair;
    git: FolderGit | undefined;
    /** Offers a new chat in the target's checkout. */
    onNewChat?: () => void;
    /** The caller's own items, in a section of their own after `Open in…`. */
    extra?: readonly OpenMenuExtra[];
    /** A last item, under a separator, `Folder settings…`, runs this (it opens the folder's settings and worktrees). Without it there is no such item. */
    onManageWorktrees?: () => void;
    /** Called when an item is pressed, before it runs: a menu that is not in a `MenuTrigger` shuts itself here. */
    onClose?: () => void;
    'aria-label': string;
}

/** The icon of an item: the program's own, the Files folder, the Terminal tab's mark, the GitHub mark, or the copy mark. */
export const actionIcon = (action: OpenAction): ReactNode => {
    if (action.program) return <AppIcon app={action.program.app} kind={action.program.kind} />;

    switch (action.id) {
        case 'files':
            return <Folder aria-hidden="true" />;
        case 'terminal':
            return <Terminal aria-hidden="true" />;
        case 'github':
            return <Github size={14} />;
        default:
            return <Copy aria-hidden="true" />;
    }
};

/** The section of a menu that holds the caller's own items, under a separator; nothing when there are none. */
export function ExtraMenuSection({ extra }: { extra: readonly OpenMenuExtra[] }) {
    if (extra.length === 0) return null;

    return (
        <>
            <MenuSeparator />
            <MenuSection aria-label="More">
                <For each={extra}>
                    {({ id, label, icon, isDanger }) => (
                        <MenuItem key={id} id={id} icon={icon} textValue={label} isDanger={isDanger}>
                            {label}
                        </MenuItem>
                    )}
                </For>
            </MenuSection>
        </>
    );
}

/**
 * The menu of a file or a folder of the project, to go inside a `Popover`. At the top what the app does itself: Open in Files and Open in Terminal (a folder, when
 * the window shows the target's place: its folder, or the worktree of the open chat), and the copies of the path. After a separator, `Open in…`, a submenu of what leaves the app: the editor, the file manager,
 * the terminal program, GitHub. One list of items for every place the menu comes from (`openActions`). `Folder settings…` is the last item, under a separator
 * (`onManageWorktrees`), which is not an action on a path and so is not in `openActions`.
 */
export function OpenWithMenu({
    target,
    missing = false,
    repair,
    git,
    onNewChat,
    extra = [],
    onManageWorktrees,
    onClose,
    'aria-label': label,
}: OpenWithMenuProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const apps = useOpenApps();
    // The Files tab shows the place the window works in (the folder, or the open chat's worktree), so a path in another folder of the project cannot be shown there, nor
    // can one in another worktree of it, nor one in a worktree that is not made yet.
    const place = placeOf(target);
    const isHere = isSamePlace(currentPlace(project, ui), place) && isPlaceReady(place);
    const actions = openActions({
        target,
        programs: chosenPrograms(apps),
        git,
        missing,
        effects: openEffects,
        inFiles: isHere
            ? () =>
                  void openInFiles(root, target.projectId, place, target.relative).then(
                      opened => !opened && toast.error({ message: 'Couldn’t open this path' })
                  )
            : undefined,
        inTerminal: isHere ? () => void openInTerminal(root, target.projectId, place, target.relative) : undefined,
    });
    const here = actions.filter(action => action.group !== 'outside');
    const outside = actions.filter(action => action.group === 'outside');
    const run = (key: string) => {
        onClose?.();

        if (key === 'manage') onManageWorktrees?.();
        else if (key === 'new-chat') onNewChat?.();
        else if (key === 'locate') repair?.locate();
        else if (key === 'remove') repair?.remove?.();
        else (extra.find(own => own.id === key) ?? actions.find(action => action.id === key))?.run();
    };
    const item = (action: OpenAction) => (
        <MenuItem
            key={action.id}
            id={action.id}
            icon={actionIcon(action)}
            textValue={action.label}
            isDisabled={action.isDisabled}
        >
            {action.label}
        </MenuItem>
    );

    return (
        <PopoverScroll>
            <Menu aria-label={label} size="sm" onAction={key => run(String(key))}>
                <MenuSection aria-label="Open">
                    {missing && (
                        <MenuHeader>
                            {target.workspace ? 'This worktree no longer exists' : 'This folder no longer exists'}
                        </MenuHeader>
                    )}
                    {repair && (
                        <MenuItem id="locate" icon={<Search aria-hidden="true" />} textValue="Locate…">
                            Locate…
                        </MenuItem>
                    )}
                    {repair?.remove && (
                        <MenuItem id="remove" icon={<Close aria-hidden="true" />} textValue="Remove from project">
                            Remove from project
                        </MenuItem>
                    )}
                    {onNewChat && (
                        <MenuItem
                            id="new-chat"
                            icon={<NewChat aria-hidden="true" />}
                            textValue="New chat"
                            isDisabled={missing || !isPlaceReady(place)}
                        >
                            New chat
                        </MenuItem>
                    )}
                    <For each={here}>{item}</For>
                </MenuSection>
                {outside.length > 0 && (
                    <>
                        <MenuSeparator />
                        <MenuSection aria-label="Other programs">
                            <SubmenuTrigger>
                                <MenuItem
                                    id="outside"
                                    icon={<Follow aria-hidden="true" />}
                                    textValue="Open in…"
                                    isDisabled={outside.every(action => action.isDisabled)}
                                    endAffix={<ChevronRight />}
                                >
                                    Open in…
                                </MenuItem>
                                <Popover spacing="xs">
                                    <Menu aria-label="Open in" size="sm" onAction={key => run(String(key))}>
                                        <For each={outside}>{item}</For>
                                    </Menu>
                                </Popover>
                            </SubmenuTrigger>
                        </MenuSection>
                    </>
                )}
                <ExtraMenuSection extra={extra} />
                {onManageWorktrees && (
                    <>
                        <MenuSeparator />
                        <MenuSection aria-label="Worktrees">
                            <MenuItem id="manage" icon={<Settings aria-hidden="true" />} textValue="Folder settings…">
                                Folder settings…
                            </MenuItem>
                        </MenuSection>
                    </>
                )}
            </Menu>
        </PopoverScroll>
    );
}
