import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { useModalContext } from '@clowdy/components/Modal';
import { DialogLayout, openFormDialog } from '@clowdy/components/modals';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { AttentionCircle } from '@clowdy/icons/14';
import { folderNames } from '@clowdy/protocol';
import { reaction } from 'mobx';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { RootStoreProvider } from '../../../stores';
import styles from './FolderWorkspaceDialog.module.css';
import { setFolderSettings } from './projectActions';
import { isWorkspaceSaved, type WorkspaceFields, workspaceFields, workspacePatch } from './projectView';

import type { FolderGit, FolderId, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../../stores';

export interface FolderWorkspaceDialogProps {
    root: RootStore;
    projectId: ProjectId;
    folderId: FolderId;
    /** The folder's short name among the project's folders, for the heading. */
    name: string;
}

interface FolderDraftState {
    folderName: string;
    fields: WorkspaceFields;
    saving: boolean;
}

/** One draft and pending-save state for the lifetime of the modal. */
function createFolderDraft(initial: FolderDraftState) {
    let state = initial;
    const listeners = new Set<() => void>();

    return {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        update: (patch: Partial<FolderDraftState>) => {
            state = { ...state, ...patch };
            for (const listener of listeners) listener();
        },
    };
}

type FolderDraft = ReturnType<typeof createFolderDraft>;

/** Opens the settings of one folder. */
export function openFolderWorkspace(props: FolderWorkspaceDialogProps): void {
    const folder = props.root.projects
        .find(project => project.id === props.projectId)
        ?.folders.find(folder => folder.id === props.folderId);
    const draft = createFolderDraft({
        folderName: folder?.settings?.name ?? '',
        fields: workspaceFields(folder?.settings),
        saving: false,
    });

    openFormDialog({
        width: 540,
        component: (
            <RootStoreProvider value={props.root}>
                <FolderWorkspaceForm {...props} draft={draft} />
            </RootStoreProvider>
        ),
    });
}

type FolderTabProps = FolderWorkspaceDialogProps & { draft: FolderDraft };

function FolderWorkspaceForm({ root, projectId, folderId, name, draft }: FolderTabProps) {
    const { modal } = useModalContext();
    const project = root.projects.find(candidate => candidate.id === projectId);
    const folder = project?.folders.find(candidate => candidate.id === folderId);
    const defaultName =
        project &&
        folderNames(
            project.folders.map(candidate =>
                candidate.id === folderId
                    ? { ...candidate, settings: { ...candidate.settings, name: undefined } }
                    : candidate
            )
        )[project.folders.findIndex(candidate => candidate.id === folderId)];
    const { folderName, fields, saving: isPending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
    const [git, setGit] = useState<FolderGit>();
    const change = (patch: Partial<WorkspaceFields>) =>
        draft.update({ fields: { ...draft.getSnapshot().fields, ...patch } });

    useEffect(
        () =>
            reaction(
                () => root.projects.some(candidate => candidate.id === projectId),
                present => {
                    if (!present) modal.cancel();
                },
                { fireImmediately: true }
            ),
        [root, projectId, modal]
    );

    // What the repository has, for the placeholder and the note about a branch it lacks. A folder git cannot be asked about shows neither.
    useEffect(() => {
        let current = true;

        root.transport.getFolderGit(projectId, folderId).then(
            answer => {
                if (current) setGit(answer);
            },
            () => undefined
        );

        return () => {
            current = false;
        };
    }, [root, projectId, folderId]);

    const saved = folder?.settings;
    const pendingChanges = !isWorkspaceSaved(fields, saved) || folderName.trim() !== (saved?.name ?? '');
    const canSubmit = folder !== undefined && !project?.personal && pendingChanges;
    // The daemon answers `defaultBranch` as the folder's base: with a base set that the repository has, it is that base, not the repository's own default.
    const detected = git?.isRepository ? git.defaultBranch : undefined;
    const typed = fields.baseBranch.trim();
    const lacksBranch =
        typed !== '' &&
        git?.isRepository === true &&
        !git.truncated &&
        !git.branches.some(branch => branch.name === typed);

    const submit = async () => {
        if (!canSubmit || draft.getSnapshot().saving) return;

        draft.update({ saving: true });

        const done = await setFolderSettings(
            root,
            { id: projectId },
            { id: folderId },
            {
                ...workspacePatch(fields),
                ...(folderName.trim() !== (saved?.name ?? '') && { name: folderName.trim() || null }),
            }
        );

        draft.update({ saving: false });

        if (done) modal.cancel();
    };

    return (
        <DialogLayout
            title={`Settings of ${name}`}
            description="Name and worktree setup of this folder"
            onSubmit={() => void submit()}
            actions={
                // No Cancel: the window's close button, Escape and a click outside already close it.
                !project?.personal && (
                    <Button type="submit" color="primary" fullWidth isDisabled={!canSubmit} isPending={isPending}>
                        Save
                    </Button>
                )
            }
        >
            {project?.personal ? (
                <Text color="secondary">Folder settings are unavailable in the personal space</Text>
            ) : (
                <>
                    <FormField layout="vertical">
                        <FormField.Label>Folder name</FormField.Label>
                        <FormField.Description>Optional name shown in this project</FormField.Description>
                        <Input
                            type="text"
                            aria-label="Folder name"
                            value={folderName}
                            onChange={folderName => draft.update({ folderName })}
                            placeholder={defaultName ?? name}
                            maxLength={100}
                            autoFocus
                        />
                    </FormField>

                    <FormField layout="vertical">
                        <FormField.Label>Base branch</FormField.Label>
                        <FormField.Description>Empty uses the default branch of the repository</FormField.Description>
                        <Input
                            type="text"
                            aria-label="Base branch"
                            value={fields.baseBranch}
                            onChange={baseBranch => change({ baseBranch })}
                            placeholder={detected && detected !== saved?.baseBranch ? detected : 'Default branch'}
                        />
                    </FormField>
                    {lacksBranch && (
                        <Text
                            variant="sm"
                            color="warning"
                            role="status"
                        >{`The repository has no branch called ${typed}, so the default branch is used`}</Text>
                    )}

                    <FormField layout="vertical">
                        <FormField.Label>Files to copy</FormField.Label>
                        <FormField.Description>One path per line, such as .env or .env*</FormField.Description>
                        <Textarea
                            value={fields.files}
                            onChange={files => change({ files })}
                            placeholder=".env"
                            rows={3}
                            autoResize
                            isResizable={false}
                            textareaClassName={styles.code}
                        />
                    </FormField>

                    <FormField layout="vertical">
                        <FormField.Label>Command</FormField.Label>
                        <FormField.Description>
                            Runs in the new worktree once the files are copied
                        </FormField.Description>
                        <Textarea
                            value={fields.command}
                            onChange={command => change({ command })}
                            placeholder="bun install"
                            rows={3}
                            autoResize
                            isResizable={false}
                            textareaClassName={styles.code}
                        />
                    </FormField>

                    {git?.isRepository === false && (
                        <Alert color="warning" role="status">
                            <AlertIcon>
                                <AttentionCircle />
                            </AlertIcon>
                            <AlertDescription>
                                Worktrees need a git repository, and this folder is not one
                            </AlertDescription>
                        </Alert>
                    )}
                    {folder === undefined && (
                        <Alert color="danger">
                            <AlertIcon>
                                <AttentionCircle />
                            </AlertIcon>
                            <AlertDescription>This folder is no longer in the project</AlertDescription>
                        </Alert>
                    )}
                </>
            )}
        </DialogLayout>
    );
}
