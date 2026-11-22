import { FileIcon } from '@clowdy/components/FileIcon';
import { Menu, MenuItem } from '@clowdy/components/List';
import { Popover, PopoverScroll, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Copy } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import { openInFiles } from '../../features/files/openInFiles';
import { useKindOnDisk } from '../../features/files/useKindOnDisk';
import { openEffects, OpenWithMenu, useFolderGit, type OpenTarget } from '../../features/openWith';
import { currentFolder } from '../../features/sidePanel/currentFolder';
import chipStyles from '../../shared/Chip.module.css';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { chipLabelFromPath, isDirectoryPath, normalizeChipPath } from './chipPath';
import { resolveChipTarget } from './chipTarget';

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
 */
function TargetMenu({ target, onClose }: { target: OpenTarget; onClose: () => void }) {
    const git = useFolderGit(target.projectId, target.folder.id);
    const kind = useKindOnDisk(target.projectId, target.folder, target.relative);

    return <OpenWithMenu target={ kind ? { ...target, kind } : target } git={ git } onClose={ onClose } aria-label="File actions" />;
}

/** The menu of a path that is in no folder of the project: only what does not need a folder, the copy of the path as it was written. */
function OutsideMenu({ path, onClose }: { path: string; onClose: () => void }) {
    return (
        <PopoverScroll>
            <Menu
                aria-label="File actions"
                size="sm"
                onAction={ () => {
                    onClose();
                    openEffects.copy(path);
                } }
            >
                <MenuItem id="copyPath" icon={ <Copy aria-hidden="true" /> } textValue="Copy path">Copy path</MenuItem>
            </Menu>
        </PopoverScroll>
    );
}

/**
 * A file or folder named in a message: its icon and name, the whole path on hover. A press opens it in the Files tab of the side panel; a right-click opens the menu
 * of the path (`OpenWithMenu`: Open in Files, the editor, the file manager, GitHub, the copies of the path). A press that has nothing to open (the file is not on
 * the disk, the path is in a folder the window is not on, or in none of the project's) opens the same menu where the pointer is, so there is always something to do with it.
 */
export function FileChip({ path, lines, className }: FileChipProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const contextMenu = useContextMenu();
    const clean = normalizeChipPath(path);
    const label = lines ? `${ chipLabelFromPath(clean) } (${ lines })` : chipLabelFromPath(clean);
    const current = currentFolder(project, ui);
    const target = resolveChipTarget({ path: clean, kind: isDirectoryPath(path) ? 'directory' : 'file' }, project.id, project.project.folders, current);

    const open = async (event: MouseEvent<HTMLButtonElement>) => {
        // Where the menu opens if there is nothing to open: at the pointer, or under the chip for a press from the keyboard (which has no pointer). Read before waiting,
        // since the event is not the chip's any more after that.
        const { left, bottom } = event.currentTarget.getBoundingClientRect();
        const at = event.detail === 0 ? { clientX: left, clientY: bottom } : { clientX: event.clientX, clientY: event.clientY };
        // The tab shows the folder the window works in: a path in another folder of the project is not there to open.
        const opened = target && target.folder.id === current.id && await openInFiles(root, project.id, target.folder, target.relative);

        if (!opened) contextMenu.areaProps.onContextMenu({ ...at, preventDefault: () => undefined } as MouseEvent);
    };

    return (
        <>
            <button
                type="button"
                className={ cn(chipStyles.chip, className) }
                title={ clean }
                aria-label={ `Open ${ clean || 'workspace' }` }
                onClick={ event => void open(event) }
                { ...contextMenu.areaProps }
            >
                <span className={ chipStyles.icon }><FileIcon path={ clean } kind={ isDirectoryPath(path) ? 'directory' : 'file' } /></span>
                <span className={ chipStyles.label }>{ label }</span>
            </button>
            <Show when={ contextMenu.isOpen }>
                <Popover { ...contextMenu.popoverProps } placement="bottom start" spacing="xs">
                    { target
                        ? <TargetMenu target={ target } onClose={ contextMenu.close } />
                        : <OutsideMenu path={ clean } onClose={ contextMenu.close } /> }
                </Popover>
            </Show>
        </>
    );
}
