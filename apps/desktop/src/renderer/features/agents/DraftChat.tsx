import { Text } from '@clowdy/components/Text';
import { useEffect, useRef } from 'react';

import { useProjectState, useProjectUi } from '../../stores';
import { ChatDropZone } from '../chats/ChatDropZone';
import { Composer, type ComposerHandle } from '../chats/Composer';
import styles from './DraftChat.module.css';

/**
 * The new-chat row's page, a start page: the heading and the message box in the middle. No chat exists yet: the composer
 * makes it when the first message is sent, and then this page gives way to the chat. A hand-off from another chat arrives
 * with its words already in the box's draft and its conversation as a file in `ui.pendingFiles`.
 */
export function DraftChat() {
    const project = useProjectState();
    const ui = useProjectUi();
    const composer = useRef<ComposerHandle>(null);
    const pending = ui.pendingFiles;

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

                    <div className={ styles.composerSlot }>
                        <Composer ref={ composer } chat={ undefined } run={ undefined } minLines={ 3 } start={ { projectId: project.id, onStarted: chatId => ui.openChat(chatId) } } />
                    </div>
                </div>
            </div>
        </ChatDropZone>
    );
}
