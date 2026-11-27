import { Button } from '@clowdy/components/Button';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { ArrowUpRight, Settings } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';
import { useMemo, useState } from 'react';

import { FolderList } from '../../../shell/FolderList';
import { useRootStore } from '../../../stores';
import { openFolderWorkspace } from './FolderWorkspaceDialog';
import styles from './ProjectDetail.module.css';
import { addFolders, locateFolderByDialog, removeFolder, reorderFolders } from './projectActions';
import { type FolderView, folderViews, missingFolderNote, type RemoteLink, siteName } from './projectView';

import type { SortableListDropContext } from '@clowdy/components/SortableList';
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
 * The Folders block of a project's page, in the `FolderList` the Add project form has too: the folders in order, the first marked Main,
 * dragged into another order, removed one by one, and more added with Add folders… or cloned from an address with Clone repository…. Each shows that it is missing, with a Locate… button that moves it to
 * the place the person picks, and opens its git
 * remote's page (Open in GitHub). Its Workspace button opens the dialog of what the worktrees made from the folder start from and need
 * (`FolderWorkspaceDialog`). A new main folder asks first and waits while agents of the project work; anything else applies at once.
 * The personal space shows its one folder, which nobody changes, and has no worktrees to set up.
 */
export function ProjectFolders({ project, info, infoFailed }: ProjectFoldersProps) {
    const root = useRootStore();
    const [dragged, setDragged] = useState<DraggedOrder | null>(null);
    // A drop that is refused before it is sent: a new list puts the rows back where the drag moved them from.
    const [listKey, setListKey] = useState(0);
    const folders = dragged?.base === project.folders ? dragged.folders : project.folders;
    const views = useMemo(() => folderViews({ folders }, info), [folders, info]);
    const working = (info?.activeRuns ?? 0) > 0;
    const mainId = project.folders[0]?.id;

    if (project.personal) return <PersonalFolder project={project} views={views} />;

    const reorder = (next: FolderView[]) => {
        const order = next.map(view => view.folder);

        // `canDrop` keeps the main folder in place while agents work; a drop that got there anyway is put back.
        if (working && order[0]?.id !== mainId) {
            setListKey(key => key + 1);

            return;
        }

        const base = project.folders;

        setDragged({ base, folders: order });
        void reorderFolders(root, project, order).then(saved => {
            if (!saved) setDragged(current => (current?.base === base ? null : current));
        });
    };

    // While agents work, the main folder neither moves nor has another dropped above it.
    const keepsMain = ({ items: [source], target }: SortableListDropContext<FolderView>) =>
        source?.folder.id !== mainId && target?.folder.id !== mainId;

    return (
        <SettingsLayout.Section
            title="Folders"
            description="The agents work in the main folder, the first one, and reach the others too. Drag a folder to change the order."
        >
            <FolderList
                key={listKey}
                items={views}
                getKey={view => view.folder.id}
                getPath={view => view.folder.path}
                getName={view => view.name}
                renderDetails={view => <FolderState project={project} view={view} />}
                renderActions={view => (
                    <>
                        <LocateButton project={project} view={view} isDisabled={view.isMain && working} />
                        {view.remote && <RemoteButton remote={view.remote} />}
                        <WorkspaceButton project={project} view={view} />
                    </>
                )}
                // A project has at least one folder.
                onRemove={views.length > 1 ? view => removeFolder(root, project, view.folder, view.chats) : undefined}
                isRemoveDisabled={view => view.isMain && working}
                onReorder={reorder}
                canDrop={working ? keepsMain : undefined}
                onAdd={paths => void addFolders(root, project, paths)}
                transport={root.transport}
                useAddDialog
            />

            {working && (
                <Text variant="sm" color="secondary" role="status">
                    Agents are working in this space. Stop them before changing the main folder.
                </Text>
            )}
            {infoFailed && (
                <Text variant="sm" color="secondary" role="status">
                    Couldn't check the folders
                </Text>
            )}
        </SettingsLayout.Section>
    );
}

/** The personal space's folder, where Clowdy keeps it: shown, never changed. */
function PersonalFolder({ project, views }: { project: Project; views: FolderView[] }) {
    return (
        <SettingsLayout.Section title="Folder">
            <FolderList
                items={views}
                getKey={view => view.folder.id}
                getPath={view => view.folder.path}
                getName={view => view.name}
                renderDetails={view => <FolderState project={project} view={view} />}
                renderActions={view => view.remote && <RemoteButton remote={view.remote} />}
            />
        </SettingsLayout.Section>
    );
}

/** Under a folder's path: that it is missing, or else a git remote that has no page to open. */
function FolderState({ project, view }: { project: Project; view: FolderView }) {
    if (view.missing)
        return (
            <Text variant="sm" color="warning">
                {missingFolderNote(project, view.isMain)}
            </Text>
        );

    return view.remote && !view.remote.href ? (
        <Text variant="sm" color="secondary" className={styles.value}>
            {view.remote.text}
        </Text>
    ) : null;
}

/**
 * For a folder that is gone from the disk: asks where it is now and moves the folder there, so its chats stay with it (`locateFolderByDialog`). Nothing for a folder that is
 * there, or in a window with no folder dialog. The main folder waits while agents work, as the page says under the list.
 */
function LocateButton({ project, view, isDisabled }: { project: Project; view: FolderView; isDisabled: boolean }) {
    const root = useRootStore();

    if (!view.missing || !window.desktop?.chooseDirectories) return null;

    return (
        <Tooltip content="Pick where the folder is now">
            <Button
                variant="filling"
                color="secondary"
                size="sm"
                aria-label={`Locate ${view.name}`}
                isDisabled={isDisabled}
                onPress={() => void locateFolderByDialog(root, project, view.folder)}
            >
                Locate…
            </Button>
        </Tooltip>
    );
}

/** Opens the dialog of the base branch and the setup the worktrees made from this folder get: a gear, whose tip says what it is for. */
function WorkspaceButton({ project, view }: { project: Project; view: FolderView }) {
    const root = useRootStore();

    return (
        <Tooltip content="Folder settings">
            <Button
                variant="filling"
                color="secondary"
                size="sm"
                iconOnly
                aria-label={`Folder settings: ${view.name}`}
                onPress={() =>
                    openFolderWorkspace({ root, projectId: project.id, folderId: view.folder.id, name: view.name })
                }
            >
                <Settings />
            </Button>
        </Tooltip>
    );
}

/** The `origin` remote's page, when it names a repository on a web host: Open in GitHub, with the repository on hover. */
function RemoteButton({ remote }: { remote: RemoteLink }) {
    if (!remote.href) return null;

    const site = siteName(remote.href);

    return (
        <Tooltip content={remote.text}>
            <Button variant="filling" color="secondary" size="sm" href={remote.href} target="_blank" rel="noreferrer">
                {site === 'GitHub' ? <Github size={14} /> : <ArrowUpRight />}
                {`Open in ${site}`}
            </Button>
        </Tooltip>
    );
}
