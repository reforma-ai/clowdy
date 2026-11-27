import { Breadcrumb } from '@clowdy/components/Breadcrumb';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { Input } from '@clowdy/components/Input';
import { useEffect, useRef, useState } from 'react';

import { useRunLabel } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { openChat, openRun } from './archiveChat';
import styles from './ConversationHeader.module.css';
import { perform } from './commands';
import { conversationHeaderPath, foldedPath, type HeaderTarget } from './conversationHeaderPath';

import type { Chat, Run } from '@clowdy/protocol';

export interface ConversationHeaderProps {
    /** The chat the page belongs to. Absent only for a sub-agent whose chat is gone. */
    chat: Chat | undefined;
    /** The native sub-agent the page shows; absent on a chat's own page (a thread is one). */
    subagent?: Run;
}

/**
 * The header over every conversation, made of the chats' own titles, in the column of the messages (not at the page's edge) and in the type of a heading of a card (`heading-5`), with no border. A chat shows its title; a thread the path down to it (`Chat › Thread`); a native sub-agent the path of
 * its chat and then its own name, with the sub-agents it runs inside between them. Every part but the last opens that page; the last is the page itself. A long path folds its
 * middle into `…`, which opens it out, and titles truncate. It has no status of the run: the stream, the box and the list's dots say it. A sub-agent's own part is what it was asked to do (`runLabel`), so there is no line for it under the path. Stop, the model and the mode are in the message box, not here.
 */
export function ConversationHeader({ chat, subagent }: ConversationHeaderProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const label = useRunLabel();
    const [isOpenedOut, setIsOpenedOut] = useState(false);
    const pathRef = useRef<HTMLDivElement>(null);

    const parts = conversationHeaderPath({
        chats: project.chats,
        runs: project.runs,
        chat,
        subagent,
        label,
    });
    const firstHidden = useRef(parts[1]?.label);

    firstHidden.current = parts[1]?.label;

    // The `…` that was pressed is gone: the keyboard goes to the first part it uncovered, not back to the top of the page. The part is found by its name, since the `…` may
    // still be in the page when this runs (the path removes a part after the render that drops it).
    useEffect(() => {
        if (!isOpenedOut) return;

        [...(pathRef.current?.querySelectorAll('button') ?? [])]
            .find(button => button.textContent === firstHidden.current)
            ?.focus();
    }, [isOpenedOut]);

    const open = (target: HeaderTarget) =>
        void (target.kind === 'chat'
            ? openChat(root, project, ui, target.chatId)
            : openRun(root, project, ui, target.runId));

    return (
        <header className={styles.root}>
            <ContentColumn className={styles.header}>
                <div className={styles.line}>
                    <div ref={pathRef} className={styles.path}>
                        <Breadcrumb variant="heading-5" aria-label="Conversation path">
                            {foldedPath(parts, isOpenedOut).map((item, index, items) => {
                                if ('fold' in item)
                                    return (
                                        <Breadcrumb.Link key="fold" onPress={() => setIsOpenedOut(true)}>
                                            <span aria-hidden>…</span>
                                            <span className={styles.visuallyHidden}>{`Show ${item.hidden} more`}</span>
                                        </Breadcrumb.Link>
                                    );

                                const { target } = item;

                                return index === items.length - 1 ? (
                                    <Breadcrumb.Page key={item.key} className={styles.page}>
                                        {chat && !subagent && chat.archivedAt === undefined ? (
                                            <ChatTitle chat={chat} label={item.label} />
                                        ) : (
                                            <span title={item.label}>{item.label}</span>
                                        )}
                                    </Breadcrumb.Page>
                                ) : (
                                    <Breadcrumb.Link
                                        key={item.key}
                                        isDisabled={target === undefined}
                                        onPress={target && (() => open(target))}
                                    >
                                        {/* A title that is cut short reads in full on hover; a chat in the archive says why it does not open. */}
                                        <span title={target ? item.label : `${item.label}, in the archive`}>
                                            {item.label}
                                        </span>
                                    </Breadcrumb.Link>
                                );
                            })}
                        </Breadcrumb>
                    </div>
                </div>
            </ContentColumn>
        </header>
    );
}

/**
 * The title of the chat the page is, which a double click turns into a field in its own place, as the title of a row in the chat list does: Enter or leaving the field
 * renames the chat, Escape keeps the name, and there is no button to save with.
 */
function ChatTitle({ chat, label }: { chat: Chat; label: string }) {
    const [isRenaming, setIsRenaming] = useState(false);

    return isRenaming ? (
        <TitleField chat={chat} onDone={() => setIsRenaming(false)} />
    ) : (
        <span title={label} onDoubleClick={() => setIsRenaming(true)}>
            {label}
        </span>
    );
}

function TitleField({ chat, onDone }: { chat: Chat; onDone: () => void }) {
    const root = useRootStore();
    const [title, setTitle] = useState(chat.title);
    const finished = useRef(false);

    const commit = () => {
        if (finished.current) return;
        finished.current = true;
        const next = title.trim();

        onDone();

        if (next && next !== chat.title) void perform(root, { type: 'chat.rename', chatId: chat.id, title: next });
    };

    return (
        <Input
            type="text"
            variant="inline"
            aria-label="Chat title"
            className={styles.titleField}
            autoFocus
            autoSelect
            value={title}
            onChange={setTitle}
            onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;

                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    finished.current = true;
                    onDone();
                }
            }}
            onBlur={commit}
        />
    );
}
