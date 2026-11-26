import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Split } from '@clowdy/icons/14';
import { useMemo, useRef } from 'react';

import { useAgents, useChatStream, useProjectState, useProjectUi, useRootStore } from '../../stores';
import { type ForkAgent, openQuestion, QuestionPanel, type StreamViewHandle } from '../../stream';
import { useRefreshGitFactsAtRunEnd } from '../changes/useRefreshGitFactsAtRunEnd';
import { ProviderIcon } from '../settings/providers/ProviderIcon';
import { ChatControls } from './ChatControls';
import { ChatDropZone } from './ChatDropZone';
import styles from './ChatView.module.css';
import { Composer, type ComposerHandle } from './Composer';
import { ConversationCrumb } from './ConversationCrumb';
import { ConversationView } from './ConversationView';
import { canCompactChat, chatProvider, chatWritability, handoffAgents } from './chatProvider';
import { isRunActive, overflowed } from './chatRun';
import { chatScrollMemory } from './chatScrollMemory';
import { perform } from './commands';
import { composerBannerPreferences } from './composerBannerPreferences';
import { LastRunPlate } from './LastRunPlate';
import { chatProgress } from './progress';
import { ReadOnlyNotice } from './ReadOnlyNotice';
import { RunningAgents } from './RunningAgents';
import { swipeToReply } from './swipeReplyPreference';
import { TasksBanner } from './TasksBanner';
import { useCompact } from './useCompact';
import { useEditMessage } from './useEditMessage';
import { useFork } from './useFork';
import { useHandoff } from './useHandoff';
import { useStreamLinks } from './useStreamLinks';

import type { Chat } from '@clowdy/protocol';
import type { ReactNode } from 'react';

/**
 * One chat: the conversation page (`ConversationView`) with the composer banners above the message box and the composer in the box's place. When the chat's provider cannot run
 * (switched off, not installed, signed out) the stream stays as it is and a notice stands in place of the composer. A thread is a chat like
 * any other, with a slim line over its stream that names the chat it belongs to and opens it. `controls` are what the line under the message box holds at its
 * start (where the chat works, read only), the line the new-chat page drew with controls that change; the composer adds the mode at the end of that line, so a chat
 * that can be written to always has the line, and a read only one has it only when the caller has `controls`.
 */
export function ChatView({ chat, controls }: { chat: Chat; controls?: ReactNode }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const scrollMemory = useMemo(() => chatScrollMemory(ui, chat.id), [ui, chat.id]);
    const links = useStreamLinks();
    const parent = chat.parentChatId === undefined ? undefined : project.chats.get(chat.parentChatId);
    // A fork says where it came from. The source opens from there while it is listed: one in the archive is named only, since opening it would bring it back.
    const source = chat.forkedFrom && project.chats.get(chat.forkedFrom.chatId);
    const origin = chat.forkedFrom && {
        atSeq: chat.forkedFrom.atSeq,
        title: source?.title,
        onOpen: source && source.archivedAt === undefined ? () => links.onOpenChat(source.id) : undefined,
    };
    const { fork, forking } = useFork(chat);
    const composer = useRef<ComposerHandle>(null);
    const streamView = useRef<StreamViewHandle>(null);
    const stream = useChatStream(chat);
    const run = chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined;
    const handOff = useHandoff(chat, run);
    // The git facts of the chat's place are read again when its run ends, whichever tab shows them.
    useRefreshGitFactsAtRunEnd(chat, run);
    const { agents, status: agentsStatus } = useAgents();
    // The agents an answer's Fork menu can hand the conversation to: the signed-in ones other than this chat's own.
    const handoffTargets = handoffAgents(agents, chat, run).map(
        (agent): ForkAgent => ({ id: agent.id, name: agent.name, icon: <ProviderIcon agentId={agent.id} size={14} /> })
    );
    const writability = chatWritability(chat, run, agents, agentsStatus);
    const progress = chatProgress(project.tasksOfChat(chat.id), project.statuses);
    const items = stream?.items ?? [];
    // The question the orchestrator waits on is answered in the box under the chat, in place of the message field. A chat that is read only has no box, so its question stays in the stream.
    const asked = run?.status === 'waiting_user' && writability.writable ? openQuestion(items) : undefined;
    const edit = useEditMessage({
        chat,
        items,
        ready: stream?.status === 'ready',
        writable: writability.writable,
        attachmentBlob: links.attachmentBlob,
    });
    // The conversation outgrew the model's window: the failure offers Compact, when the chat can still be written to and its agent can compact.
    const overflowAt =
        overflowed(run) && writability.writable && canCompactChat(chat, run, agents)
            ? items.findLast(item => item.body.kind === 'error')?.id
            : undefined;

    return (
        <ChatDropZone
            disabled={!writability.writable}
            onFiles={files => composer.current?.addFiles(files)}
            onPasteFiles={files => composer.current?.pasteFiles(files)}
        >
            <ConversationView
                ref={streamView}
                run={run}
                stream={stream}
                links={links}
                top={parent && <ThreadCrumb parent={parent} onOpen={() => links.onOpenChat(parent.id)} />}
                scrollMemory={scrollMemory}
                // Reply puts a message in the message box as a card, or quotes selected words into the draft; a fork is a conversation to go on in, and an edit sends the
                // message again: a chat that is read only has none of them. The chat is rewritten from a message only at rest, so while the agent works Edit is not drawn.
                messageActions={
                    writability.writable
                        ? {
                              onReply: message => composer.current?.reply(message),
                              onQuote: text => composer.current?.quote(text),
                              swipeToReply: swipeToReply.enabled,
                              onFork: fork,
                              forkingId: forking,
                              onHandoff: (itemId, engine) => void handOff({ itemId, engine }),
                              ownAgent: chatProvider(chat, run),
                              handoffAgents: handoffTargets,
                              onEdit: edit.begin,
                              editBusy: isRunActive(run),
                          }
                        : {}
                }
                editing={
                    edit.session && writability.writable
                        ? {
                              itemId: edit.session.itemId,
                              onCancel: edit.cancel,
                              editor: (
                                  <Composer
                                      chat={chat}
                                      run={run}
                                      editMode={{
                                          draftKey: edit.session.draftKey,
                                          onSubmit: edit.submit,
                                          onCancel: edit.cancel,
                                          isPending: edit.pending,
                                      }}
                                  />
                              ),
                          }
                        : undefined
                }
                forkedFrom={origin}
                emptyState={<EmptyChat />}
                errorAction={item => (item.id === overflowAt ? <CompactAction chatId={chat.id} /> : null)}
                dockedQuestionId={asked?.questionId}
                banners={
                    <>
                        <RunningAgents chat={chat} />
                        {/* What the chat's latest run changed, once it is at rest and the person has not written since; for a read only chat too. */}
                        {composerBannerPreferences.showChanges && (
                            <LastRunPlate
                                chat={chat}
                                run={run}
                                items={stream?.status === 'ready' ? items : undefined}
                            />
                        )}
                        {composerBannerPreferences.showTasks && progress && (
                            <TasksBanner key={chat.id} progress={progress} />
                        )}
                    </>
                }
                bottom={
                    // The composer draws the line under its box itself, with the mode at the end of it; a chat that is read only has no mode to show.
                    writability.writable ? (
                        <Composer
                            ref={composer}
                            chat={chat}
                            run={run}
                            controls={controls}
                            onSendMessage={() => streamView.current?.followLatest()}
                            question={
                                asked && run ? (
                                    <QuestionPanel
                                        bounded
                                        key={asked.questionId}
                                        question={asked}
                                        onAnswer={async answer => {
                                            await perform(root, {
                                                type: 'run.answer',
                                                runId: run.id,
                                                questionId: asked.questionId,
                                                answer,
                                            });
                                        }}
                                    />
                                ) : undefined
                            }
                        />
                    ) : (
                        <>
                            <ReadOnlyNotice chat={chat} run={run} message={writability.message} />

                            {controls && <ChatControls>{controls}</ChatControls>}
                        </>
                    )
                }
            />
        </ChatDropZone>
    );
}

/** The line over a thread's stream: whose thread it is, and the parent's title, which opens the parent. */
function ThreadCrumb({ parent, onOpen }: { parent: Chat; onOpen: () => void }) {
    return (
        <ConversationCrumb label="Parent chat" icon={<Split />} lead="Thread of" title={parent.title} onOpen={onOpen} />
    );
}

/** Compact on the failure of a turn whose conversation no longer fit the model's window: the next turn compacts it, and the chat goes on. */
function CompactAction({ chatId }: { chatId: string }) {
    const { compact, isPending } = useCompact(chatId);

    return (
        <Button size="sm" variant="bordered" isPending={isPending} onPress={() => void compact()}>
            Compact
        </Button>
    );
}

function EmptyChat() {
    return (
        <div className={styles.empty}>
            <Text variant="heading-4">What are we working on?</Text>
            <Text color="secondary">
                Describe what you want built, or ask a question. In Hands-off mode Clowdy plans and runs the work on its
                own; in Hands-on mode it stops to ask you at the big decisions.
            </Text>
        </div>
    );
}
