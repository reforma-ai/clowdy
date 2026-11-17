import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Message } from '@clowdy/icons/14';

import { useProjectState, useProjectUi } from '../../stores';
import { ChatList } from './ChatList';
import { ChatView } from './ChatView';
import styles from './Screen.module.css';
import { useStartChat } from './useStartChat';

/** Chats: the list of the project's chats beside the selected one. */
export function Screen() {
    const project = useProjectState();
    const ui = useProjectUi();
    // A remembered chat may be gone: the first one stands in.
    const chat = (ui.chatId ? project.chats.get(ui.chatId) : undefined) ?? project.chatList[0];

    return (
        <div className={ styles.screen }>
            <ChatList selectedId={ chat?.id } />
            <section className={ styles.main } aria-label="Chat">
                { chat ? <ChatView key={ chat.id } chat={ chat } /> : <NoChats /> }
            </section>
        </div>
    );
}

function NoChats() {
    const { start, isCreating } = useStartChat();

    return (
        <div className={ styles.empty }>
            <Message size={ 28 } />
            <Text variant="heading-2">Start with a chat</Text>
            <Text color="secondary">
                Tell the orchestrator what you want built, or ask about the project. It plans the work as tasks and runs agents on them in parallel.
            </Text>
            <Button color="primary" isPending={ isCreating } onPress={ () => void start() }>Start a chat</Button>
        </div>
    );
}
