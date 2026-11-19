import { Button } from '@clowdy/components/Button';
import { SortableList, type SortableListDropContext } from '@clowdy/components/SortableList';
import { Text } from '@clowdy/components/Text';
import { ArrowUpRight, Plus } from '@clowdy/icons/14';
import { useEffect, useMemo, useRef, useState } from 'react';

import { FolderRow } from '../../../shell/FolderRow';
import { useRootStore } from '../../../stores';
import { SettingsSection } from '../ui/SettingsSection';
import { addFolders, removeFolder, reorderFolders } from './projectActions';
import styles from './ProjectDetail.module.css';
import { folderViews, missingFolderNote, type FolderView, type RemoteLink } from './projectView';

import type { Project, ProjectFolder, ProjectInfo } from '@clowdy/protocol';

export interface ProjectFoldersProps {
    project: Project;
    info: ProjectInfo | undefined;
    /** The last read of `info` failed: what is shown may be out of date, or missing. */
    infoFailed: boolean;
}

/** An order dragged on this page, shown until the daemon's own list (`base` no longer the project's) or its refusal arrives. */
interface DraggedOrder {
    base: readonly ProjectFolder[];
    folders: ProjectFolder[];
}

/**
 * The Folders block of a project's page: the folders in order, the first marked Main, dragged into another order, removed one by one, and
 * more added with Add folders…. Each shows that it is missing, or its git remote. A new main folder asks first and waits while agents of the
 * project work; anything else applies at once. The personal space shows its one folder, which nobody changes.
 */
export function ProjectFolders({ project, info, infoFailed }: ProjectFoldersProps) {
    const root = useRootStore();
    const group = useRef<HTMLDivElement>(null);
    const [dragged, setDragged] = useState<DraggedOrder | null>(null);
    // A drop that is refused before it is sent: a new list puts the rows back where the drag moved them from.
    const [listKey, setListKey] = useState(0);
    // The place of a removed row, where the focus goes once the row is gone, so it does not fall out of the page.
    const focusAfterRemoval = useRef<number | null>(null);
    const folders = dragged?.base === project.folders ? dragged.folders : project.folders;
    const views = useMemo(() => folderViews({ folders }, info), [folders, info]);
    const working = (info?.activeRuns ?? 0) > 0;
    const mainId = project.folders[0]?.id;

    useEffect(() => {
        const index = focusAfterRemoval.current;

        if (index === null) return;

        focusAfterRemoval.current = null;

        const rows = group.current?.querySelectorAll('[data-folder-path]') ?? [];
        const row = rows[Math.min(index, rows.length - 1)];

        (row?.querySelector<HTMLElement>('button[aria-label^="Remove"]') ?? group.current?.querySelector<HTMLElement>('[data-add-folders]'))?.focus();
    }, [project.folders]);

    if (project.personal) return <PersonalFolder project={ project } view={ views[0] } />;

    const reorder = (next: FolderView[]) => {
        const order = next.map(view => view.folder);

        // `canDrop` keeps the main folder in place while agents work; a drop that got there anyway is put back.
        if (working && order[0]?.id !== mainId) {
            setListKey(key => key + 1);

            return;
        }

        const base = project.folders;

        setDragged({ base, folders: order });
        void reorderFolders(root, project, order).then((saved) => {
            if (!saved) setDragged(current => (current?.base === base ? null : current));
        });
    };

    const remove = (view: FolderView, index: number) => {
        focusAfterRemoval.current = index;
        void removeFolder(root, project, view.folder).then((removed) => {
            if (!removed) focusAfterRemoval.current = null;
        });
    };

    // While agents work, the main folder neither moves nor has another dropped above it.
    const keepsMain = ({ items: [source], target }: SortableListDropContext<FolderView>) => source?.folder.id !== mainId && target?.folder.id !== mainId;

    return (
        <SettingsSection
            title="Folders"
            description="The agents work in the main folder, the first one, and reach the others too. Drag a folder to change the order."
        >
            <div ref={ group } className={ styles.folders }>
                <SortableList
                    key={ listKey }
                    aria-label="Folders"
                    items={ views }
                    gap="sm"
                    getKey={ view => view.folder.id }
                    getTextValue={ view => view.name }
                    getDragHandleOptions={ () => ({ variant: 'surface', edgeOffset: '10' }) }
                    canDrop={ working ? keepsMain : undefined }
                    onChange={ reorder }
                >
                    { (view, { index }) => (
                        <FolderRow
                            name={ view.name }
                            path={ view.folder.path }
                            isMain={ view.isMain }
                            // A project has at least one folder.
                            onRemove={ views.length > 1 ? () => remove(view, index) : undefined }
                            isRemoveDisabled={ view.isMain && working }
                        >
                            <FolderState project={ project } view={ view } />
                        </FolderRow>
                    ) }
                </SortableList>

                <Button variant="bordered" size="sm" className={ styles.add } data-add-folders onPress={ () => void addFolders(root, project) }>
                    <Plus />Add folders…
                </Button>
            </div>

            { working && <Text variant="sm" color="secondary" role="status">Agents are working in this project. Stop them before changing the main folder.</Text> }
            { infoFailed && <Text variant="sm" color="secondary" role="status">Couldn't check the folders</Text> }
        </SettingsSection>
    );
}

/** The personal space's folder, where Clowdy keeps it: shown, never changed. */
function PersonalFolder({ project, view }: { project: Project; view: FolderView | undefined }) {
    return (
        <SettingsSection title="Folder">
            { view && (
                <FolderRow name={ view.name } path={ view.folder.path }>
                    <FolderState project={ project } view={ view } />
                </FolderRow>
            ) }
        </SettingsSection>
    );
}

/** Under a folder's path: that it is missing, or else its git remote. */
function FolderState({ project, view }: { project: Project; view: FolderView }) {
    if (view.missing) return <Text variant="sm" color="warning">{ missingFolderNote(project, view.isMain) }</Text>;

    return view.remote ? <Remote remote={ view.remote } /> : null;
}

/** The `origin` remote, a link when it names a repository on a web host. */
function Remote({ remote }: { remote: RemoteLink }) {
    return (
        <Text variant="sm" className={ styles.value }>
            { remote.href
                ? <Button variant="inline" color="primary" href={ remote.href } target="_blank" rel="noreferrer" className={ styles.value }>{ remote.text }<ArrowUpRight aria-hidden /></Button>
                : remote.text }
        </Text>
    );
}
