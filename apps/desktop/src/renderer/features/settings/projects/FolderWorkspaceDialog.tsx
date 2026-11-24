import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { folderNames } from '@clowdy/protocol';
import { type FormEvent, useEffect, useId, useState } from 'react';

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

/**
 * "Workspace" of one folder of a project: what the worktrees made from it start from and need. A base branch (empty: the repository's default
 * branch), the files copied from the folder into a new worktree, one path per line (`.env`), and a command that runs in it afterwards (`bun install`).
 * They belong to this folder of this project, whose folders are different repositories. The form reads the folder by its id each time it is
 * drawn, so a folder that left the project meanwhile is said so and cannot be saved. No `title` option: the heading is drawn in the form,
 * and the window's own close button floats at the corner.
 */
export function openFolderWorkspace(props: FolderWorkspaceDialogProps): void {
    Modal.create({
        width: 480,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: true,
        handle: false,
        component: <FolderWorkspaceForm {...props} />,
    });
}

function FolderWorkspaceForm({ root, projectId, folderId, name }: FolderWorkspaceDialogProps) {
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
    const [folderName, setFolderName] = useState(() => folder?.settings?.name ?? '');
    const [fields, setFields] = useState<WorkspaceFields>(() => workspaceFields(folder?.settings));
    const [git, setGit] = useState<FolderGit>();
    const [isPending, setIsPending] = useState(false);
    const change = (patch: Partial<WorkspaceFields>) => setFields(current => ({ ...current, ...patch }));

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
    const canSubmit =
        folder !== undefined && (!isWorkspaceSaved(fields, saved) || folderName.trim() !== (saved?.name ?? ''));
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

        if (!canSubmit || isPending) return;

        setIsPending(true);

        const done = await setFolderSettings(
            root,
            { id: projectId },
            { id: folderId },
            {
                ...workspacePatch(fields),
                ...(folderName.trim() !== (saved?.name ?? '') && { name: folderName.trim() || null }),
            }
        );

        setIsPending(false);

        if (done) modal.cancel();
    };

    return (
        <form className={styles.form} onSubmit={event => void submit(event)}>
            <div className={styles.heading}>
                <Text variant="heading-3" truncate>{`Workspace of ${name}`}</Text>
                <Text color="secondary">What a new worktree of this folder starts from and needs</Text>
            </div>

            <FormField layout="vertical">
                <FormField.Label>Folder name</FormField.Label>
                <FormField.Description>Optional name shown in this project</FormField.Description>
                <Input
                    type="text"
                    aria-label="Folder name"
                    value={folderName}
                    onChange={setFolderName}
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
                <Text variant="sm" color="warning" role="status">
                    Worktrees need a git repository, and this folder is not one
                </Text>
            )}
            {folder === undefined && (
                <Text color="danger" role="alert">
                    This folder is no longer in the project
                </Text>
            )}

            {/* No Cancel: the window's close button, Escape and a click outside already close it. */}
            <Button type="submit" color="primary" fullWidth isDisabled={!canSubmit} isPending={isPending}>
                Save
            </Button>
        </form>
    );
}
