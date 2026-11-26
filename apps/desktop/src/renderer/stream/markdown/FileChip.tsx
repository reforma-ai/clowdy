import { FileIcon } from '@clowdy/components/FileIcon';
import { For } from '@clowdy/components/For';
import { Menu, MenuHeader, MenuItem, MenuSection } from '@clowdy/components/List';
import { Popover, PopoverScroll, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { toast } from '@clowdy/components/Toast';
import { Copy } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import { openInFiles } from '../../features/files/openInFiles';
import { useKindOnDisk } from '../../features/files/useKindOnDisk';
import {
    absolutePath,
    actionItem,
    chosenPrograms,
    type FolderGit,
    OpenInSubmenu,
    type OpenTarget,
    OpenWithMenu,
    openActions,
    openEffects,
    useFolderGit,
    useOpenApps,
} from '../../features/openWith';
import { currentPlace, isSamePlace, placeOf, placePath } from '../../features/sidePanel/currentPlace';
import chipStyles from '../../shared/Chip.module.css';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { findChipFiles, useFoundFiles } from './chipFind';
import { chipLabelFromPath, isDirectoryPath, normalizeChipPath } from './chipPath';
import { isAbsolute, resolveChipTarget } from './chipTarget';

import type { MouseEvent } from 'react';

/** How many of the files a written path could mean are listed to choose from. */
const MATCHES_SHOWN = 10;

export interface FileChipProps {
    /** A path inside the project, as an agent or a person wrote it. */
    path: string;
    /** `12` or `12-20`, from a citation of lines. */
    lines?: string;
    className?: string;
}

/**
 * The menu of a path that is in a folder of the project: the same as everywhere (`OpenWithMenu`), with the git facts of its folder read when it opens. A path
 * written with no trailing slash is taken for a file until the disk says it is a folder (the terminal, `Open in Finder` and the `/tree/` page of GitHub follow).
 * When the disk says the path is not there, nothing in that menu could work on it, so it gives way to `MissingMenu`.
 */
function TargetMenu({ target, onClose }: { target: OpenTarget; onClose: () => void }) {
    const git = useFolderGit(target.projectId, target.folder.id, target.workspace);
    const kind = useKindOnDisk(target.projectId, target, target.relative);

    if (kind === null) return <MissingMenu target={target} git={git} onClose={onClose} />;

    return (
        <OpenWithMenu
            target={kind ? { ...target, kind } : target}
            git={git}
            onClose={onClose}
            aria-label="File actions"
        />
    );
}

/**
 * The menu of a path that is not on the disk. A message often names a file by its name alone (`FileChip.tsx`), which is not in the folder's root though the file is in the
 * project, so the files that end with the written path are looked for (`useFoundFiles`): one of them is the file, and it gets the menu of any file (`OpenWithMenu`); several are
 * listed to choose from (`MatchesMenu`); none, or a place the window is not on, leaves `AbsentMenu`.
 */
function MissingMenu({
    target,
    git,
    onClose,
}: {
    target: OpenTarget;
    git: FolderGit | undefined;
    onClose: () => void;
}) {
    const project = useProjectState();
    const ui = useProjectUi();
    const isHere = isSamePlace(currentPlace(project, ui), placeOf(target));
    const found = useFoundFiles(target, isHere);

    if (found?.length === 1) {
        const relative = found[0]!;

        return (
            <OpenWithMenu
                target={{ ...target, path: absolutePath(placePath(target), relative), relative, kind: 'file' }}
                git={git}
                onClose={onClose}
                aria-label="File actions"
            />
        );
    }

    if (found && found.length > 1) return <MatchesMenu target={target} found={found} onClose={onClose} />;

    return <AbsentMenu target={target} isLooking={found === undefined} onClose={onClose} />;
}

/** The files that a written path could mean, one row each, the first few of them; pressing a row opens that file in the Files tab. */
function MatchesMenu({ target, found, onClose }: { target: OpenTarget; found: string[]; onClose: () => void }) {
    const root = useRootStore();

    return (
        <PopoverScroll>
            <Menu
                aria-label="File actions"
                size="sm"
                onAction={key => {
                    onClose();
                    void openInFiles(root, target.projectId, placeOf(target), String(key)).then(
                        opened => !opened && toast.error({ message: 'Couldn’t open this path' })
                    );
                }}
            >
                <MenuSection aria-label="Files">
                    <MenuHeader>Several files match</MenuHeader>
                    <For each={found.slice(0, MATCHES_SHOWN)}>
                        {path => (
                            <MenuItem key={path} id={path} icon={<FileIcon path={path} kind="file" />} textValue={path}>
                                {path}
                            </MenuItem>
                        )}
                    </For>
                </MenuSection>
            </Menu>
        </PopoverScroll>
    );
}

/**
 * The menu of a path that is not on the disk and that no file of the project ends with (an agent named a file it has not made, or one that was moved): it says so, and keeps the
 * copies of the path, the one thing that still works. While the project is searched for it, it says that instead.
 */
function AbsentMenu({
    target,
    isLooking = false,
    onClose,
}: {
    target: OpenTarget;
    isLooking?: boolean;
    onClose: () => void;
}) {
    return (
        <PopoverScroll>
            <Menu
                aria-label="File actions"
                size="sm"
                onAction={key => {
                    onClose();
                    openEffects.copy(key === 'copyRelative' ? target.relative : target.path);
                }}
            >
                <MenuSection aria-label="Path">
                    <MenuHeader>
                        {isLooking
                            ? 'Looking for this file'
                            : `This ${target.kind === 'directory' ? 'folder' : 'file'} doesn't exist`}
                    </MenuHeader>
                    <MenuItem id="copyPath" icon={<Copy aria-hidden="true" />} textValue="Copy path">
                        Copy path
                    </MenuItem>
                    {target.relative !== '' && (
                        <MenuItem id="copyRelative" icon={<Copy aria-hidden="true" />} textValue="Copy relative path">
                            Copy relative path
                        </MenuItem>
                    )}
                </MenuSection>
            </Menu>
        </PopoverScroll>
    );
}

/**
 * The menu of a path that is in no folder of the project: what does not need a folder. The copy of the path as it was written, and for a full path (a drive letter or a leading
 * slash) what leaves the app, as `Open in…` has it everywhere: the editor, the file manager (it shows a file), the terminal program (a folder only). The desktop app opens a path
 * that is on the disk wherever it is, and says so with a toast when it is not. A path written from the project's folder that climbs out of it (`../a`) is not a place on the disk
 * to open, so it has the copy only.
 */
function OutsideMenu({ path, kind, onClose }: { path: string; kind: OpenTarget['kind']; onClose: () => void }) {
    const apps = useOpenApps();
    const actions = openActions({
        target: { path, relative: '', kind },
        programs: isAbsolute(path) ? chosenPrograms(apps) : {},
        effects: openEffects,
    });
    const run = (key: string) => {
        onClose();
        actions.find(action => action.id === key)?.run();
    };

    return (
        <PopoverScroll>
            <Menu aria-label="File actions" size="sm" onAction={key => run(String(key))}>
                <For each={actions.filter(action => action.group === 'copy')}>{actionItem}</For>
                <OpenInSubmenu actions={actions.filter(action => action.group === 'outside')} onAction={run} />
            </Menu>
        </PopoverScroll>
    );
}

/**
 * A file or folder named in a message: its icon and name, the whole path on hover. A press opens it in the Files tab of the side panel; a right-click, a click with
 * ⌘ or Ctrl held, and a long touch (`installLongPressContextMenu`) open the menu of the path (`OpenWithMenu`: Open in Files, the editor, the file manager, GitHub, the copies of the path). A press
 * that has nothing to open (the file is not on the disk, the path is in a folder the window is not on, or in none of the project's) opens the same menu where the
 * pointer is, so there is always something to do with it. A file that is not at the written path is looked for in the folder (`findChipFiles`): when one file ends with the path
 * (a bare `FileChip.tsx`) the press opens it, when several do the menu lists them (`MatchesMenu`), when none does the menu says so and has only the copies of the path. A path
 * in no folder of the project has the copy and `Open in…` (`OutsideMenu`), since the file is still there to show in the file manager.
 */
export function FileChip({ path, lines, className }: FileChipProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const contextMenu = useContextMenu();
    const clean = normalizeChipPath(path);
    const label = lines ? `${chipLabelFromPath(clean)} (${lines})` : chipLabelFromPath(clean);
    const current = currentPlace(project, ui);
    const target = resolveChipTarget(
        { path: clean, kind: isDirectoryPath(path) ? 'directory' : 'file' },
        project.id,
        project.project.folders,
        current
    );

    const open = async (event: MouseEvent<HTMLButtonElement>) => {
        // Where the menu opens if there is nothing to open: at the pointer, or under the chip for a press from the keyboard (which has no pointer). Read before waiting,
        // since the event is not the chip's any more after that.
        const { left, bottom } = event.currentTarget.getBoundingClientRect();
        const [x, y] = event.detail === 0 ? [left, bottom] : [event.clientX, event.clientY];

        // ⌘ on a Mac, Ctrl on Windows: the menu, as a right-click gives it, in place of opening the file.
        if (event.metaKey || event.ctrlKey) {
            contextMenu.openAt(x, y);

            return;
        }

        // The tab shows the place the window works in (the folder, or the open chat's worktree): a path in another folder of the project, or in the folder's own checkout
        // while the chat works in a worktree, is not there to open.
        const isHere = target !== undefined && isSamePlace(target, current);
        const opened = isHere && (await openInFiles(root, project.id, current, target.relative));

        if (!opened) {
            // A file that is not where the message wrote it may be deeper in the folder (a bare name): one such file is the one meant and is opened, several are the menu's to list.
            const found =
                isHere && target.kind === 'file'
                    ? await findChipFiles(root, project.id, current, target.relative).catch(() => [])
                    : [];

            if (found.length === 1 && (await openInFiles(root, project.id, current, found[0]!))) return;

            if (isHere && found.length < 2) toast.error({ message: 'Couldn’t open this path' });
            contextMenu.openAt(x, y);
        }
    };

    return (
        <>
            <button
                type="button"
                className={cn(chipStyles.chip, className)}
                title={clean}
                aria-label={`Open ${clean || 'workspace'}`}
                onClick={event => void open(event)}
                {...contextMenu.areaProps}
            >
                <span className={chipStyles.icon}>
                    <FileIcon path={clean} kind={isDirectoryPath(path) ? 'directory' : 'file'} />
                </span>
                <span className={chipStyles.label}>{label}</span>
            </button>
            <Show when={contextMenu.isOpen}>
                <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">
                    {target ? (
                        <TargetMenu target={target} onClose={contextMenu.close} />
                    ) : (
                        <OutsideMenu
                            path={clean}
                            kind={isDirectoryPath(path) ? 'directory' : 'file'}
                            onClose={contextMenu.close}
                        />
                    )}
                </Popover>
            </Show>
        </>
    );
}
