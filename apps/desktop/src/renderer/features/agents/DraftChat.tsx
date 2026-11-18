import { PanelHeader } from '@clowdy/components/Panel';
import { Text } from '@clowdy/components/Text';

import { useProjectState, useProjectUi } from '../../stores';
import { Composer } from '../chats/Composer';
import styles from './DraftChat.module.css';

/**
 * The new-chat row's page, a start page: the heading and the message box in the middle. No chat exists yet: the composer
 * makes it when the first message is sent, and then this page gives way to the chat.
 */
export function DraftChat() {
    const project = useProjectState();
    const ui = useProjectUi();

    return (
        <div className={ styles.draft }>
            <PanelHeader>
                <span>New chat</span>
            </PanelHeader>

            <div className={ styles.center }>
                <Text variant="heading-3">What should we work on?</Text>

                <div className={ styles.composerSlot }>
                    <Composer chat={ undefined } run={ undefined } minLines={ 3 } start={ { projectId: project.id, onStarted: chatId => ui.openChat(chatId) } } />
                </div>
            </div>
        </div>
    );
}
