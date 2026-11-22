import { useContextMenu } from '@clowdy/components/Popover';
import { useEffect, useState, type MouseEvent } from 'react';

import { ArchiveMenu } from './ArchiveMenu';
import { openWork } from './archiveRules';

import type { Task, TaskId } from '@clowdy/protocol';
import type { ListCursor } from '../../hotkeys/listCursor';
import type { ProjectState } from '../../stores';
import type { TaskTree } from './taskTree';

export interface UseArchiveMenuOptions {
    project: ProjectState;
    /** The tasks of the board as a tree, which says what work is open under a task. */
    tree: TaskTree;
    cursor: ListCursor;
    archive: (tasks: readonly Task[]) => void;
}

/**
 * The menu of a card or a row: `open` is for the `contextmenu` event of one (a right-click, and the menu key or Shift+F10, which send it to the focused card or row), and
 * `menu` is drawn once, anywhere on the screen. It acts on the selection when the task that was pressed is in it, and on that task alone when it is not, as a file manager does.
 * The tasks are read again from the board while the menu is open, so one that is gone meanwhile is dropped.
 */
export function useArchiveMenu({ project, tree, cursor, archive }: UseArchiveMenuOptions) {
    const contextMenu = useContextMenu();
    const [ids, setIds] = useState<readonly TaskId[]>([]);
    const targets = contextMenu.isOpen ? ids.flatMap(id => project.tasks.get(id) ?? []) : [];
    const hasOpenWork = targets.some(task => openWork(task, tree, project.statuses).length > 0);
    const isVanished = contextMenu.isOpen && targets.length === 0;
    const { close } = contextMenu;

    // Every task the menu was for is gone (deleted, or archived by an agent) while it was open: there is nothing to act on, and the open state would stay on with no menu drawn.
    useEffect(() => {
        if (isVanished) close();
    }, [isVanished, close]);

    return {
        open: (event: MouseEvent, taskId: TaskId) => {
            setIds(cursor.selected.has(taskId) ? cursor.targets() : [taskId]);
            contextMenu.areaProps.onContextMenu(event);
        },
        menu: <ArchiveMenu contextMenu={ contextMenu } targets={ targets } isOpen={ hasOpenWork } onArchive={ archive } />,
    };
}
