import { ContentColumn } from '@clowdy/components/ContentColumn';
import { Text } from '@clowdy/components/Text';
import { mainFolder } from '@clowdy/protocol';
import { useEffect, useRef } from 'react';

import { useProjectState, useProjectUi } from '../../stores';
import { ChatControls } from '../chats/ChatControls';
import { ChatDropZone } from '../chats/ChatDropZone';
import { Composer, type ComposerHandle } from '../chats/Composer';
import { newChatDefaults, startingChoice } from '../chats/newChatDefaults';
import { draftTarget } from './agentTree';
import styles from './DraftChat.module.css';
import { DraftFolderSelect } from './DraftFolderSelect';

import type { FolderId } from '@clowdy/protocol';

/**
 * The new-chat row's page, a start page: the heading and the message box in the middle. No chat exists yet: the composer
 * makes it when the first message is sent, and then this page gives way to the chat. A hand-off from another chat arrives
 * with its words already in the box's draft and its conversation as a file in `ui.pendingFiles`. While the list is grouped by folder a select under the box
 * says which folder the chat is for (`ui.draftFolderId`, the main folder's when none) and changes it: the chat then works there. `missing` are the folders
 * gone from the disk, which the select lists and does not let be picked. The chat this page makes keeps the line, with the folder read only (`ChatFolder`).
 */
export function DraftChat({ missing }: { missing: ReadonlySet<FolderId> }) {
    const project = useProjectState();
    const ui = useProjectUi();
    // What the project asks a new chat to start with, or the app's choice where it follows the app; what neither names starts where the last chat left off.
    const defaults = startingChoice(project.project.settings, newChatDefaults);
    const composer = useRef<ComposerHandle>(null);
    const pending = ui.pendingFiles;
    const { folders } = project.project;
    const grouped = ui.groupByFolder && folders.length > 1;
    const target = grouped ? draftTarget(folders, ui.draftFolderId) : undefined;
    // The main folder is what a chat works in when it names no folder.
    const folderId = target && !target.isMain ? target.folder.id : undefined;

    // Files a hand-off left here join the message as if they were picked: the box uploads them to this project. What the effect adds is
    // what the store hands over, so a second run of it (strict mode) finds nothing and adds nothing.
    useEffect(() => {
        if (pending.length === 0 || !composer.current) return;

        const files = ui.takePendingFiles();

        if (files.length > 0) composer.current.addFiles(files);
    }, [pending, ui]);

    return (
        <ChatDropZone onFiles={ files => composer.current?.addFiles(files) }>
            <div className={ styles.draft }>
                <div className={ styles.center }>
                    <Text variant="heading-3">What should we work on?</Text>

                    <ContentColumn className={ styles.composerSlot }>
                        <Composer ref={ composer } chat={ undefined } run={ undefined } minLines={ 3 } start={ { projectId: project.id, folderId, onStarted: chatId => ui.openChat(chatId), defaults } } />

                        { target && (
                            <ChatControls>
                                <DraftFolderSelect
                                    folders={ folders }
                                    selectedId={ target.folder.id }
                                    missing={ missing }
                                    // The main folder is the one a chat that names none works in.
                                    onPick={ folder => ui.setDraftFolder(folder.id === mainFolder(project.project).id ? null : folder.id) }
                                />
                            </ChatControls>
                        ) }
                    </ContentColumn>
                </div>
            </div>
        </ChatDropZone>
    );
}
