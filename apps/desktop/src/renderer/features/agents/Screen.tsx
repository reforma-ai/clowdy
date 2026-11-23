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
    // The folders gone from the disk are told from what the daemon last read, when the screen opens, when the projects change and when the window gets focus again. The list
    // and the new-chat page share that one read: it costs a `git` call for each folder of each project, so each of them reading it would repeat it. The branches of the chats'
    // worktrees (`ProjectInfo.workspaces`) are in it too, which is why it follows the focus (an agent switches branches in a terminal or in the background) and the worktrees that get
    // made: a read taken while a worktree was being made says it is not there, and would make the list call it gone once it is.
    const madeWorkspaces = [...project.chats.values()]
        .flatMap(chat => (chat.workspace?.ready ? [chat.workspace.id] : []))
        .sort()
        .join();
    const { info } = useProjectsInfo({ poll: false, refreshOnFocus: true, reloadKey: madeWorkspaces });
    const projectInfo = info.get(project.id);
    const missing = new Set(projectInfo?.folders.filter(folder => !folder.exists).map(folder => folder.folderId));

    // The line under a chat's message box holds its folder and where it works in it (the branch, with `Worktree` before it in a worktree), read only, where the new-chat page had the select and the one control of its place; it is always there, whatever the project's folders.
    const where = chat ? chatFolder(project.chats, project.project.folders, chat.id) : undefined;

    return (
        <SidebarLayout
            screen="agents"
            defaultWidth={270}
            sidebar={
                <AgentList
                    selection={selection}
                    chats={chats}
                    missing={missing}
                    workspaces={projectInfo?.workspaces}
                    isCovered={expanded}
                />
            }
        >
            <section
                className={styles.main}
                aria-label={run ? 'Sub-agent' : 'Chat'}
                data-covered={expanded || undefined}
            >
                {run ? (
                    <RunDetail key={run.id} run={run} />
                ) : chat ? (
                    <ChatView
                        key={chat.id}
                        chat={chat}
                        controls={
                            where && (
                                <ChatFolder
                                    name={where.name}
                                    folder={where.folder}
                                    missing={missing.has(where.folder.id)}
                                    workspace={chat.workspace}
                                />
                            )
                        }
                    />
                ) : (
                    <DraftChat missing={missing} />
                )}
            </section>
        </SidebarLayout>
    );
}
