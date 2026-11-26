import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { AttentionCircle } from '@clowdy/icons/14';
import { folderNames } from '@clowdy/protocol';
import { reaction } from 'mobx';
import { type FormEvent, useEffect, useId, useState, useSyncExternalStore } from 'react';

import { RootStoreProvider } from '../../../stores';
import { FolderWorktreesList } from '../../worktrees/FolderWorktreesList';
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
    initialTab?: 'settings' | 'worktrees';
}

interface FolderDraftState {
    folderName: string;
    fields: WorkspaceFields;
    saving: boolean;
}

/** One draft and pending-save state for the lifetime of the modal, across native tab remounts. */
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

/** Opens folder settings and worktrees in one window with native modal tabs. */
export function openFolderWorkspace(props: FolderWorkspaceDialogProps): void {
    const folder = props.root.projects
        .find(project => project.id === props.projectId)
        ?.folders.find(folder => folder.id === props.folderId);
    const draft = createFolderDraft({
        folderName: folder?.settings?.name ?? '',
        fields: workspaceFields(folder?.settings),
        saving: false,
    });

    Modal.create({
        width: 540,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: true,
        handle: false,
        activeTab: props.initialTab ?? 'settings',
        tabs: [
            {
                id: 'settings',
                title: 'Settings',
                component: (
                    <RootStoreProvider value={props.root}>
                        <FolderWorkspaceForm {...props} draft={draft} />
                    </RootStoreProvider>
                ),
            },
            {
                id: 'worktrees',
                title: 'Worktrees',
                component: (
                    <RootStoreProvider value={props.root}>
                        <FolderWorktreesTab {...props} draft={draft} />
                    </RootStoreProvider>
                ),
            },
        ],
    });
}

type FolderTabProps = FolderWorkspaceDialogProps & { draft: FolderDraft };

function FolderWorktreesTab({ root, projectId, folderId, draft }: FolderTabProps) {
    const project = root.projects.find(candidate => candidate.id === projectId);
    const saved = project?.folders.find(candidate => candidate.id === folderId)?.settings;
    const { fields, folderName, saving } = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
    const pendingChanges = !isWorkspaceSaved(fields, saved) || folderName.trim() !== (saved?.name ?? '');

    return (
        <div className={styles.form}>
            <FolderWorktreesList
                projectId={projectId}
                folderId={folderId}
                pendingChanges={!project?.personal && (pendingChanges || saving)}
            />
        </div>
    );
}

function FolderWorkspaceForm({ root, projectId, folderId, name, draft }: FolderTabProps) {
    const { modal } = useModalContext();
    const filesId = useId();
    const filesHintId = useId();
    const commandId = useId();
    const commandHintId = useId();
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

    const submit = async (event: FormEvent) => {
        event.preventDefault();

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
        <div className={styles.form}>
            <form className={styles.fields} onSubmit={event => void submit(event)}>
                <div className={styles.heading}>
                    <Text variant="heading-3" truncate>{`Settings of ${name}`}</Text>
                    <Text color="secondary">Name and worktree setup of this folder</Text>
                </div>

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
                            <FormField.Description>
                                Empty uses the default branch of the repository
                            </FormField.Description>
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

                        {/* Not a FormField: the Textarea would pass the field's `isDisabled` and `isInvalid` on to the DOM and React would warn. */}
                        <div className={styles.field}>
                            <div className={styles.copy}>
                                <Text as="label" variant="heading-5" htmlFor={filesId}>
                                    Files to copy
                                </Text>
                                <Text id={filesHintId} variant="sm" color="secondary">
                                    One path per line, such as .env or .env*
                                </Text>
                            </div>
                            <Textarea
                                id={filesId}
                                aria-describedby={filesHintId}
                                value={fields.files}
                                onChange={files => change({ files })}
                                placeholder=".env"
                                rows={3}
                                autoResize
                                isResizable={false}
                                textareaClassName={styles.code}
                            />
                        </div>

                        <div className={styles.field}>
                            <div className={styles.copy}>
                                <Text as="label" variant="heading-5" htmlFor={commandId}>
                                    Command
                                </Text>
                                <Text id={commandHintId} variant="sm" color="secondary">
                                    Runs in the new worktree once the files are copied
                                </Text>
                            </div>
                            <Textarea
                                id={commandId}
                                aria-describedby={commandHintId}
                                value={fields.command}
                                onChange={command => change({ command })}
                                placeholder="bun install"
                                rows={3}
                                autoResize
                                isResizable={false}
                                textareaClassName={styles.code}
                            />
                        </div>

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

                        {/* No Cancel: the window's close button, Escape and a click outside already close it. */}
                        <Button type="submit" color="primary" fullWidth isDisabled={!canSubmit} isPending={isPending}>
                            Save
                        </Button>
                    </>
                )}
            </form>
        </div>
    );
}
