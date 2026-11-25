import { isBusyRunStatus } from '@clowdy/protocol';
import { useEffect, useRef } from 'react';

import { SidebarLayout } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { ChatView } from '../chats/ChatView';
import { refreshFolderGit } from '../openWith/useFolderGit';
import { useProjectsInfo } from '../settings/projects/useProjectsInfo';
import { useSidePanel } from '../sidePanel';
import { AgentList } from './AgentList';
import { chatFolder, orchestratorOf, resolveSelection, visibleChats } from './agentTree';
import { ChatFolder } from './ChatFolder';
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
    const { settingsOpen } = useRootStore().ui;
    // The expanded side panel is drawn over the chat, which stays where it is: hidden, so it takes no click, no key and no reader.
    const { expanded } = useSidePanel();
    // A remembered chat or run may be gone: the chat that was open, or the first one listed, stands in.
    const chats = visibleChats([...project.chats.values()], ui.chatOrder);
    const selection = resolveSelection(project.chats, chats, project.runs, ui.chatId, ui.runId, ui.draft);
    const { chat, run } = selection;
    const chatRun = chat && orchestratorOf(chat, project.runs);
    useEffect(() => {
        if (expanded || settingsOpen || run || chatRun?.status !== 'succeeded') return;

        const markSeen = () => {
            if (document.visibilityState === 'visible' && document.hasFocus()) ui.markCompletionSeen(chatRun);
        };

        markSeen();
        window.addEventListener('focus', markSeen);
        document.addEventListener('visibilitychange', markSeen);
        return () => {
            window.removeEventListener('focus', markSeen);
            document.removeEventListener('visibilitychange', markSeen);
        };
    }, [expanded, settingsOpen, run, chatRun, ui]);

    // The list and the new-chat page share the read that detects folders gone from disk.
    const { info } = useProjectsInfo({ poll: false, refreshOnFocus: true, refreshProjectId: project.id });
    const projectInfo = info.get(project.id);
    const missing = new Set(projectInfo?.folders.filter(folder => !folder.exists).map(folder => folder.folderId));

    // Show the folder only when the project has several; the workspace label remains available for every chat.
    const where = chat ? chatFolder(project.chats, project.project.folders, chat.id) : undefined;

    // An agent may have pushed, opened a pull request, or switched its worktree without using the panel.
    // Refresh the affected folders once when a turn finishes, even if its chat was not the selected one.
    const busy = new Map(
        [...project.runs.values()].flatMap(run =>
            run.role === 'orchestrator' && isBusyRunStatus(run.status) && run.chatId
                ? [[run.id, chatFolder(project.chats, project.project.folders, run.chatId)?.folder.id] as const]
                : []
        )
    );
    const previous = useRef({ projectId: project.id, busy });
    useEffect(() => {
        const before = previous.current;
        previous.current = { projectId: project.id, busy };
        if (before.projectId !== project.id) return;
        const endedFolders = new Set<string>();
        for (const [id, folder] of before.busy) if (folder && !busy.has(id)) endedFolders.add(folder);
        for (const folder of endedFolders) refreshFolderGit(project.id, folder);
    });

    return (
        <SidebarLayout
            screen="agents"
            defaultWidth={270}
            sidebar={
                <AgentList
                    selection={selection}
                    chats={chats}
                    missing={missing}
                    isCovered={expanded}
                    projectInfo={projectInfo}
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
                                    showFolder={project.project.folders.length > 1}
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
