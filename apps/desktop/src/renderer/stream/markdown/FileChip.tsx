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
    actionItem,
    chosenPrograms,
    OpenInSubmenu,
    type OpenTarget,
    OpenWithMenu,
    openActions,
    openEffects,
    useFolderGit,
    useOpenApps,
} from '../../features/openWith';
import { currentPlace, isSamePlace, placeOf } from '../../features/sidePanel/currentPlace';
import chipStyles from '../../shared/Chip.module.css';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { chipLabelFromPath, isDirectoryPath, normalizeChipPath } from './chipPath';
import { isAbsolute, resolveChipTarget } from './chipTarget';

import type { MouseEvent } from 'react';

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
 * When the disk says the path is not there, nothing in that menu could work on it, so it gives way to `AbsentMenu`.
 */
function TargetMenu({ target, onClose }: { target: OpenTarget; onClose: () => void }) {
    const git = useFolderGit(target.projectId, target.folder.id, target.workspace);
    const kind = useKindOnDisk(target.projectId, target, target.relative);

    if (kind === null) return <AbsentMenu target={target} onClose={onClose} />;

    return (
        <OpenWithMenu
            target={kind ? { ...target, kind } : target}
            git={git}
            onClose={onClose}
            aria-label="File actions"
        />
    );
}

/** The menu of a path that is not on the disk (an agent named a file it has not made, or one that was moved): it says so, and keeps the copies of the path, the one thing that still works. */
function AbsentMenu({ target, onClose }: { target: OpenTarget; onClose: () => void }) {
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
                    <MenuHeader>{`This ${target.kind === 'directory' ? 'folder' : 'file'} doesn't exist`}</MenuHeader>
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
 * pointer is, so there is always something to do with it; for a path that is not on the disk the menu says so and has only the copies of the path, and for one in no folder
 * of the project it has the copy and `Open in…` (`OutsideMenu`), since the file is still there to show in the file manager.
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
        const opened =
            target && isSamePlace(target, current) && (await openInFiles(root, project.id, current, target.relative));

        if (!opened) {
            if (target && isSamePlace(target, current)) toast.error({ message: 'Couldn’t open this path' });
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
