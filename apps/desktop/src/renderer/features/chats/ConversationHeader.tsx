import { Breadcrumb } from '@clowdy/components/Breadcrumb';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { Text } from '@clowdy/components/Text';
import { useEffect, useRef, useState } from 'react';

import { RunStatusPill, useRunLabel } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { orchestratorOf } from '../agents/agentTree';
import { openChat, openRun } from './archiveChat';
import styles from './ConversationHeader.module.css';
import { isRunActive } from './chatRun';
import { conversationHeaderPath, foldedPath, type HeaderTarget } from './conversationHeaderPath';

import type { Chat, Run } from '@clowdy/protocol';

export interface ConversationHeaderProps {
    /** The chat the page belongs to. Absent only for a sub-agent whose chat is gone. */
    chat: Chat | undefined;
    /** The native sub-agent the page shows; absent on a chat's own page (a thread is one). */
    subagent?: Run;
}

/**
 * The thin header over every conversation, made of the chats' own titles. A chat shows its title; a thread the path down to it (`Chat › Thread`); a native sub-agent the path of
 * its chat and then its own name, with the sub-agents it runs inside between them. Every part but the last opens that page; the last is the page itself. A long path folds its
 * middle into `…`, which opens it out, and titles truncate. While the page's run works or waits, its status stands at the right end, and a sub-agent's summary
 * is one quiet line under the path. Stop, the model and the mode are in the message box, not here.
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

    const run = subagent ?? (chat && orchestratorOf(chat, project.runs));
    const summary = subagent?.summary.trim();

    const open = (target: HeaderTarget) =>
        void (target.kind === 'chat'
            ? openChat(root, project, ui, target.chatId)
            : openRun(root, project, ui, target.runId));

    return (
        <ContentColumn className={styles.header}>
            <div className={styles.line}>
                <div ref={pathRef} className={styles.path}>
                    <Breadcrumb variant="sm" aria-label="Conversation path">
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
                                    <span title={item.label}>{item.label}</span>
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

                {isRunActive(run) && <RunStatusPill run={run} className={styles.status} />}
            </div>

            {summary && (
                <Text variant="xs" color="secondary" truncate title={summary} className={styles.summary}>
                    {summary}
                </Text>
            )}
        </ContentColumn>
    );
}
