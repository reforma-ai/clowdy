import { SidebarLayout } from '../../shared';
import { useProjectState, useProjectUi } from '../../stores';
import { ChatView } from '../chats/ChatView';
import { AgentList } from './AgentList';
import { resolveSelection, visibleChats } from './agentTree';
import { DraftChat } from './DraftChat';
import { RunDetail } from './RunDetail';
import styles from './Screen.module.css';

/**
 * Agents: the tree of chats and the runs below them on the left, and beside it the selected one: a chat with its message
 * box, a run of a chat (its work, read only), or the new-chat row.
 */
export function Screen() {
    const project = useProjectState();
    const ui = useProjectUi();
    // A remembered chat or run may be gone: the chat that was open, or the first one listed, stands in.
    const selection = resolveSelection(project.chats, visibleChats(project.chatList, ui.showArchived), project.runs, ui.chatId, ui.runId, ui.draft);
    const { chat, run } = selection;

    return (
        <SidebarLayout screen="agents" defaultWidth={ 270 } sidebar={ <AgentList selection={ selection } chats={ visibleChats(project.chatList, ui.showArchived, chat?.id) } /> }>
            <section className={ styles.main } aria-label={ run ? 'Subthread' : 'Chat' }>
                { run
                    ? <RunDetail key={ run.id } run={ run } />
                    : chat
                        ? <ChatView key={ chat.id } chat={ chat } />
                        : <DraftChat /> }
            </section>
        </SidebarLayout>
    );
}
