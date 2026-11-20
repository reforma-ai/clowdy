import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Completed, Error as ErrorMark, Split, TaskCanceled } from '@clowdy/icons/14';
import { use, type ReactNode } from 'react';

import { Clamp } from './Clamp';
import { Markdown } from './Markdown';
import { StreamLinksContext } from './StreamLinks';
import styles from './ThreadCards.module.css';
import { OUTCOME_WORDS } from './threadMessages';

import type { ChatId, ThreadNotice, ThreadOutcome } from '@clowdy/protocol';

/** The lines of a stopped thread's words that show until the person opens the rest. */
const NOTICE_LINES = 4;
/** The lines of a thread's message (a whole brief, often) that show until the person opens the rest, as many as of the person's own long messages. */
const MESSAGE_LINES = 16;

const OUTCOME_ICONS: Record<ThreadOutcome, ReactNode> = {
    finished: <Completed />,
    failed: <ErrorMark />,
    interrupted: <TaskCanceled />,
};

/** A thread's name in a card: a link that opens the thread, or plain words when the project no longer has it (or nothing opens chats here). */
function ChatName({ chatId, title }: { chatId: ChatId; title: string }) {
    const { hasChat, onOpenChat } = use(StreamLinksContext);

    if (!onOpenChat || hasChat?.(chatId) === false) return <span>{ title }</span>;

    return <Button variant="inline" className={ styles.link } onPress={ () => onOpenChat(chatId) }>{ title }</Button>;
}

export interface ThreadMessageCardProps {
    /** The chat that wrote: a thread of the same tree, or the parent that started this thread. */
    chatId: ChatId;
    title: string;
    text: string;
    /** The stream item this message is, so the turn rail can scroll to it. */
    turn?: string;
}

/**
 * A message another chat of the thread tree wrote (`clowdy thread tell`, or the first message of a thread from its parent): an agent wrote it, not the
 * person, so it is a card in the family of the agent cards and not a bubble. The sender's name opens it; the words are Markdown as an agent's are,
 * clamped when long.
 */
export function ThreadMessageCard({ chatId, title, text, turn }: ThreadMessageCardProps) {
    return (
        <div className={ styles.card } data-slot="thread-message" data-turn={ turn }>
            <span className={ styles.icon } aria-hidden><Split /></span>
            <div className={ styles.body }>
                <span className={ styles.title }>
                    Message from <ChatName chatId={ chatId } title={ title } />
                </span>
                { text.trim() !== '' && (
                    <Clamp lines={ MESSAGE_LINES } moreLabel="Show full message" align="start">
                        <Markdown text={ text } />
                    </Clamp>
                ) }
            </div>
        </div>
    );
}

/** One thread that stopped: how it ended, its last words (clamped), and what it still has open when its words are not its final result. */
function NoticeCard({ notice }: { notice: ThreadNotice }) {
    const open = notice.background ?? [];
    const text = notice.text?.trim() ?? '';

    return (
        <div className={ styles.card } data-slot="thread-notice" data-outcome={ notice.outcome }>
            <span className={ styles.icon } aria-hidden>{ OUTCOME_ICONS[notice.outcome] }</span>
            <div className={ styles.body }>
                <span className={ styles.title }>
                    <ChatName chatId={ notice.chatId } title={ notice.title } /> { OUTCOME_WORDS[notice.outcome] }
                </span>
                { text !== '' && open.length > 0 && <Text variant="xs" color="secondary">Not the final result</Text> }
                { text !== '' && (
                    <Clamp lines={ NOTICE_LINES } moreLabel="Show more" align="start">
                        <Markdown text={ text } />
                    </Clamp>
                ) }
                { open.length > 0 && <Text variant="sm" color="secondary" className={ styles.open }>{ `Still running: ${ open.join(', ') }` }</Text> }
            </div>
        </div>
    );
}

export interface ThreadNoticeCardsProps {
    /** One entry per thread that stopped, as the parent was told in one message. */
    threads: readonly ThreadNotice[];
    /** The stream item the notice is, so the turn rail can scroll to it. */
    turn?: string;
}

/** What a chat is told when threads below it stop: a card per thread, together as one group in the stream. */
export function ThreadNoticeCards({ threads, turn }: ThreadNoticeCardsProps) {
    return (
        <div role="group" aria-label="Threads that stopped" className={ styles.group } data-turn={ turn }>
            { threads.map(notice => <NoticeCard key={ notice.chatId } notice={ notice } />) }
        </div>
    );
}
