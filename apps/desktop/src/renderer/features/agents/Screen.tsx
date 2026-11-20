import { SidebarLayout } from '../../shared';
import { useProjectState, useProjectUi } from '../../stores';
import { ChatView } from '../chats/ChatView';
import { AgentList } from './AgentList';
import { resolveSelection, visibleChats } from './agentTree';
import { DraftChat } from './DraftChat';
import { RunDetail } from './RunDetail';
import styles from './Screen.module.css';

/**
 * Agents: the list of chats on the left, each with its threads below it, and beside it the selected one: a chat (a thread is one) with its
 * message box, a sub-agent's run of a chat (its work, read only), or the new-chat row.
 */
export function Screen() {
    const project = useProjectState();
    const ui = useProjectUi();
    // A remembered chat or run may be gone: the chat that was open, or the first one listed, stands in.
    const selection = resolveSelection(project.chats, visibleChats(project.chatList, ui.chatSort), project.runs, ui.chatId, ui.runId, ui.draft);
    const { chat, run } = selection;

    return (
        <SidebarLayout screen="agents" defaultWidth={ 270 } sidebar={ <AgentList selection={ selection } chats={ visibleChats(project.chatList, ui.chatSort) } /> }>
            <section className={ styles.main } aria-label={ run ? 'Sub-agent' : 'Chat' }>
                { run
                    ? <RunDetail key={ run.id } run={ run } />
                    : chat
                        ? <ChatView key={ chat.id } chat={ chat } />
                        : <DraftChat /> }
            </section>
        </SidebarLayout>
    );
}
