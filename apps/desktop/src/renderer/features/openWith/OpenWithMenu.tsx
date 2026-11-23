import { For } from '@clowdy/components/For';
import { Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator, SubmenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { toast } from '@clowdy/components/Toast';
import { ChevronRight } from '@clowdy/icons/8';
import { Close, Copy, Folder, Follow, Search, Terminal, Version } from '@clowdy/icons/14';
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

export interface OpenWithMenuProps {
    target: OpenTarget;
    /** The folder is gone from the disk: what needs it is off, and the menu says so. */
    missing?: boolean;
    /** For a folder that is gone: Locate… and Remove from project, under the note (`useFolderRepair`). */
    repair?: FolderRepair;
    git: FolderGit | undefined;
    /** A last item, under a separator, `Manage worktrees…`, runs this (it opens the dialog of the project's worktrees). Without it there is no such item. */
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

/**
 * The menu of a file or a folder of the project, to go inside a `Popover`. At the top what the app does itself: Open in Files and Open in Terminal (a folder, when
 * the window shows the target's place: its folder, or the worktree of the open chat), and the copies of the path. After a separator, `Open in…`, a submenu of what leaves the app: the editor, the file manager,
 * the terminal program, GitHub. One list of items for every place the menu comes from (`openActions`). `Manage worktrees…` is the last item, under a separator
 * (`onManageWorktrees`), which is not an action on a path and so is not in `openActions`.
 */
export function OpenWithMenu({
    target,
    missing = false,
    repair,
    git,
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
                      opened => !opened && toast.error({ message: 'That path is not on the disk' })
                  )
            : undefined,
        inTerminal: isHere ? () => void openInTerminal(root, target.projectId, place, target.relative) : undefined,
    });
    const here = actions.filter(action => action.group !== 'outside');
    const outside = actions.filter(action => action.group === 'outside');
    const run = (key: string) => {
        onClose?.();

        if (key === 'manage') onManageWorktrees?.();
        else if (key === 'locate') repair?.locate();
        else if (key === 'remove') repair?.remove?.();
        else actions.find(action => action.id === key)?.run();
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
                    {missing && <MenuHeader>This folder no longer exists</MenuHeader>}
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
                {onManageWorktrees && (
                    <>
                        <MenuSeparator />
                        <MenuSection aria-label="Worktrees">
                            <MenuItem id="manage" icon={<Version aria-hidden="true" />} textValue="Manage worktrees…">
                                Manage worktrees…
                            </MenuItem>
                        </MenuSection>
                    </>
                )}
            </Menu>
        </PopoverScroll>
    );
}
