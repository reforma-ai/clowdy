import { ContentColumn } from '@clowdy/components/ContentColumn';
import { Text } from '@clowdy/components/Text';
import { mainFolder } from '@clowdy/protocol';
import { useEffect, useRef } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { ChatDropZone } from '../chats/ChatDropZone';
import { Composer, type ComposerHandle } from '../chats/Composer';
import { newChatDefaults, startingChoice } from '../chats/newChatDefaults';
import { currentPlace } from '../sidePanel/currentPlace';
import { openManageWorktrees } from '../worktrees';
import { draftTarget } from './agentTree';
import { DraftFolder } from './ChatFolder';
import styles from './DraftChat.module.css';
import { DraftFolderSelect } from './DraftFolderSelect';
import { useDraftWorkspaceRow } from './useDraftWorkspaceRow';
import { useFolderRepository } from './useFolderRepository';
import { useMainBranch } from './useMainBranch';
import { WorkspaceChips } from './WorkspaceChips';
import { effectiveChoice } from './workspaceChoice';

import type { FolderId } from '@clowdy/protocol';

/**
 * The new-chat row's page, a start page: the heading and the message box in the middle. No chat exists yet: the composer
 * makes it when the first message is sent, and then this page gives way to the chat. A hand-off from another chat arrives
 * with its words already in the box's draft and its conversation as a file in `ui.pendingFiles`. A line under the box (drawn by the composer, with the mode at its end) says which folder the chat is for
 * (`ui.draftFolderId`, the main folder's when none): a select that changes it in a project of several folders, the folder read only (`DraftFolder`) in one of a
 * single folder. After the folder comes the one control of where it works in it (`WorkspaceChips`: the branch of the folder's checkout, a new worktree, or an existing one), from what git says of the folder (`useFolderRepository`) and what the person
 * chose (`ui.draftWorkspace`); the first message sends what that read bears out (`effectiveChoice`). A branch picked for the folder's own checkout is switched by the daemon as the chat is made
 * (`useMainBranch`): the message goes only once that is done, and a refusal keeps the words in the box and says why in the pill. A worktree that exists, once chosen, is also the place of the window's tabs (`useDraftWorkspaceRow`). `missing` are the folders gone from the disk, which the select lists and does not let be
 * picked. The chat this page makes keeps the line, with the folder and the place read only (`ChatFolder`).
 */
export function DraftChat({ missing }: { missing: ReadonlySet<FolderId> }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    // What the project asks a new chat to start with, or the app's choice where it follows the app; what neither names starts where the last chat left off. A page opened for an
    // agent (a hand-off to another one, `ui.draftEngine`) starts on it, whatever those say; the person's own pick in the box comes before all of them.
    const defaults = {
        ...startingChoice(project.project.settings, newChatDefaults),
        ...(ui.draftEngine && { engine: ui.draftEngine }),
    };
    const composer = useRef<ComposerHandle>(null);
    const pending = ui.pendingFiles;
    const { folders } = project.project;
    const target = draftTarget(folders, ui.draftFolderId);
    // The main folder is what a chat works in when it names no folder.
    const folderId = target.isMain ? undefined : target.folder.id;
    const repository = useFolderRepository(project.id, target.folder.id);
    const selected = ui.draftWorkspace;
    // The daemon validates an existing path. A stale listing must never send the first message to the main checkout instead.
    const workspace = effectiveChoice(selected, repository) ?? (selected?.mode === 'existing' ? selected : undefined);

    // The branch of the folder's own checkout, when the person picked one: the daemon switches it as the chat is made.
    const mainBranch = useMainBranch(project.id, target.folder.id, workspace);
    // A worktree that exists is the place of the page (its files, shells and `@` list) as soon as it is chosen, and the chat the first message makes works in the same row.
    useDraftWorkspaceRow(project.id, target.folder.id, workspace);

    // The worktree the page works in once its row is there: the same the window's tabs show, and the box's `@` list reads.
    const workspaceRow = currentPlace(project, ui).workspace;

    // The branch or base for a new worktree comes from the Git listing. An existing checkout is validated by path.
    const waiting =
        selected !== null && selected.mode !== 'existing' && repository.status === 'loading'
            ? "Wait until the folder's worktrees are read"
            : undefined;

    // A project with no chat shows this page whether or not the store says the new-chat page is open (`resolveSelection`), and the store keeps what is chosen here (the folder, where it works, the
    // branch) only while the page is open: an empty project's first chat would otherwise ignore every pick of the pill. Opening it changes nothing the person sees.
    useEffect(() => {
        if (!ui.draft) ui.openDraft();
    }, [ui]);

    // Files a hand-off left here join the message as if they were picked: the box uploads them to this project. What the effect adds is
    // what the store hands over, so a second run of it (strict mode) finds nothing and adds nothing.
    useEffect(() => {
        if (pending.length === 0 || !composer.current) return;

        const files = ui.takePendingFiles();

        if (files.length > 0) composer.current.addFiles(files);
    }, [pending, ui]);

    return (
        <ChatDropZone onFiles={files => composer.current?.addFiles(files)}>
            <div className={styles.draft}>
                <div className={styles.center}>
                    <Text variant="heading-3">What should we work on?</Text>

                    <ContentColumn className={styles.composerSlot}>
                        <Composer
                            ref={composer}
                            chat={undefined}
                            run={undefined}
                            minLines={3}
                            start={{
                                projectId: project.id,
                                folderId,
                                workspace,
                                ...(workspaceRow && { workspaceRow }),
                                ...(mainBranch.around && { around: mainBranch.around }),
                                waiting,
                                onStarted: chatId => ui.openChat(chatId),
                                defaults,
                            }}
                            controls={
                                <>
                                    {folders.length > 1 ? (
                                        <DraftFolderSelect
                                            folders={folders}
                                            selectedId={target.folder.id}
                                            missing={missing}
                                            // The main folder is the one a chat that names none works in.
                                            onPick={folder =>
                                                ui.setDraftFolder(
                                                    folder.id === mainFolder(project.project).id ? null : folder.id
                                                )
                                            }
                                        />
                                    ) : (
                                        // A project of one folder has nothing to pick: the line says where the chat will work, as the chat's own does.
                                        <DraftFolder
                                            name={target.name}
                                            folder={target.folder}
                                            missing={missing.has(target.folder.id)}
                                        />
                                    )}
                                    <WorkspaceChips
                                        repository={repository}
                                        choice={workspace}
                                        workspaceRow={workspaceRow}
                                        chats={project.chats}
                                        main={mainBranch.controls}
                                        onChoose={choice => ui.setDraftWorkspace(choice)}
                                        onManage={() =>
                                            openManageWorktrees({
                                                root,
                                                projectId: project.id,
                                                folderId: target.folder.id,
                                            })
                                        }
                                    />
                                </>
                            }
                        />
                    </ContentColumn>
                </div>
            </div>
        </ChatDropZone>
    );
}
