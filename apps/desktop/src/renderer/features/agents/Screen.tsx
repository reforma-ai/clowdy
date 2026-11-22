import { SidebarLayout } from '../../shared';
import { useProjectState, useProjectUi } from '../../stores';
import { ChatView } from '../chats/ChatView';
import { useProjectsInfo } from '../settings/projects/useProjectsInfo';
import { useSidePanel } from '../sidePanel';
import { AgentList } from './AgentList';
import { chatFolder, resolveSelection, visibleChats } from './agentTree';
import { ChatFolder } from './ChatFolder';
import { chatListPreferences } from './chatListPreferences';
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
    // The expanded side panel is drawn over the chat, which stays where it is: hidden, so it takes no click, no key and no reader.
    const { expanded } = useSidePanel();
    // A remembered chat or run may be gone: the chat that was open, or the first one listed, stands in.
    const chats = visibleChats(project.chatList, chatListPreferences.sort);
    const selection = resolveSelection(project.chats, chats, project.runs, ui.chatId, ui.runId, ui.draft);
    const { chat, run } = selection;
    // The folders gone from the disk are told from what the daemon last read, once, when the screen opens and when the projects change. The list and the
    // new-chat page share that one read: it costs a `git` call for each folder of each project, so each of them reading it would repeat it.
    const { info } = useProjectsInfo({ poll: false });
    const missing = new Set(info.get(project.id)?.folders.filter(folder => !folder.exists).map(folder => folder.folderId));

    // The line under a chat's message box holds its folder, read only, where the new-chat page had the select; it is always there, whatever the project's folders.
    const where = chat ? chatFolder(project.chats, project.project.folders, chat.id) : undefined;

    return (
        <SidebarLayout screen="agents" defaultWidth={ 270 } sidebar={ <AgentList selection={ selection } chats={ chats } missing={ missing } /> }>
            <section className={ styles.main } aria-label={ run ? 'Sub-agent' : 'Chat' } data-covered={ expanded || undefined }>
                { run
                    ? <RunDetail key={ run.id } run={ run } />
                    : chat
                        ? <ChatView key={ chat.id } chat={ chat } controls={ where && <ChatFolder name={ where.name } folder={ where.folder } missing={ missing.has(where.folder.id) } /> } />
                        : <DraftChat missing={ missing } /> }
            </section>
        </SidebarLayout>
    );
}
