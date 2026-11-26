import { Button } from '@clowdy/components/Button';
import { Shimmer } from '@clowdy/components/Shimmer';
import { Text } from '@clowdy/components/Text';
import { ProgressLoader } from '@clowdy/icons/assets';
import { type ReactNode, use, useId } from 'react';

import { AgentMark } from '../features/agents/AgentMark';
import { Clamp } from './Clamp';
import { Markdown } from './Markdown';
import { OutcomeMark } from './OutcomeMark';
import { StreamLinksContext } from './StreamLinks';
import styles from './ThreadCards.module.css';
import { OUTCOME_WORDS } from './threadMessages';

import type { ChatId, ThreadNotice, ThreadOutcome } from '@clowdy/protocol';

/** The lines of a report that show until the person opens the rest. */
const REPORT_LINES = 4;
/** The lines of a thread's message (a whole brief, often) that show until the person opens the rest, as many as of the person's own long messages. */
const MESSAGE_LINES = 16;
/** What opens the rest of a long text in a card, as it does on the person's own long messages. */
const MORE_LABEL = 'Show full message';

/** What opens a chat from a card that names it: nothing when the project no longer has that chat (or nothing opens chats here). */
function useOpenChat(chatId: ChatId): (() => void) | undefined {
    const { hasChat, onOpenChat } = use(StreamLinksContext);

    if (!onOpenChat || hasChat?.(chatId) === false) return undefined;

    return () => onOpenChat(chatId);
}

/**
 * The name a chat has now, for a card that was written when it had another: a message and a notice keep the title the chat had then, and a rename would leave the old one on its
 * cards while the header, the list and the strip say the new. Without links, or when the project no longer has the chat, it is the title the card kept.
 */
function useChatTitle(chatId: ChatId, kept: string): string {
    const { chatOfId } = use(StreamLinksContext);
    const now = chatOfId?.(chatId)?.title;

    return now !== undefined && now.trim() !== '' ? now : kept;
}

/** A thread's name in a card: a link that opens the thread, or plain words when the project no longer has it (or nothing opens chats here). */
function ChatName({ chatId, title }: { chatId: ChatId; title: string }) {
    const open = useOpenChat(chatId);
    const shown = useChatTitle(chatId, title);

    if (!open) return <span>{shown}</span>;

    return (
        <Button variant="inline" className={styles.link} onPress={open}>
            {shown}
        </Button>
    );
}

interface CardFrameProps {
    /** What a test or a style finds the card by: `agent-card` or `thread-message`. */
    slot: string;
    /** The mark that opens the title line: the title and the mark are one line, and what is under it starts at the card's edge. */
    icon: ReactNode;
    /** The title line's words (a press, a link, a shimmer). */
    title: ReactNode;
    /** How it ended, for the colour of its mark. */
    outcome?: ThreadOutcome;
    pressable?: boolean;
    busy?: boolean;
    /** The stream item the card is, so the turn rail can scroll to it. */
    turn?: string;
    /** What is under the title line. */
    children?: ReactNode;
}

/** The one frame of every card of other work in a stream: the plate, a title line that holds the icon, and the rows under it. */
function CardFrame({ slot, icon, title, outcome, pressable, busy, turn, children }: CardFrameProps) {
    return (
        <div
            className={styles.card}
            data-slot={slot}
            data-outcome={outcome}
            data-pressable={pressable ? '' : undefined}
            data-turn={turn}
            aria-busy={busy || undefined}
        >
            <div className={styles.head}>
                <span className={styles.icon} aria-hidden>
                    {icon}
                </span>
                <span className={styles.title}>{title}</span>
            </div>
            {children}
        </div>
    );
}

export interface AgentCardProps {
    /** What the agent or the thread is called: what a sub-agent was asked to do, or a thread's title. */
    name: string;
    /** How it ended, said after its name (`finished`, `failed`, `was interrupted`). None while it works. */
    outcome?: ThreadOutcome;
    /** While it works: what it does now, under its name. */
    activity?: string;
    /** Its last words, or why it failed: Markdown, clamped when long. */
    report?: string;
    /** Titles of what it still has open in the background, when its report is not its final result. */
    open?: readonly string[];
    /** Opens its page or its chat: the card is pressable (the title is the button, and the card around it takes the press; the report's words are left to be selected). Without it the card is not pressable. */
    onOpen?: () => void;
}

/**
 * The card of other work in a stream, for a sub-agent and for a thread alike: a loader and the name shimmering while it works, with what it does now; once it has
 * stopped an icon for how it ended, the name and how it ended (`Fix login finished`), its report clamped under them, and what it still has open in the background.
 */
export function AgentCard({ name, outcome, activity, report, open = [], onOpen }: AgentCardProps) {
    const running = outcome === undefined;
    const activityId = useId();
    const text = report?.trim() ?? '';
    const title = running ? <Shimmer duration={1}>{name}</Shimmer> : `${name} ${OUTCOME_WORDS[outcome]}`;

    return (
        <CardFrame
            slot="agent-card"
            icon={running ? <ProgressLoader size={14} /> : <OutcomeMark outcome={outcome} />}
            title={
                onOpen ? (
                    <button
                        type="button"
                        className={styles.press}
                        aria-describedby={activity ? activityId : undefined}
                        onClick={onOpen}
                    >
                        {title}
                    </button>
                ) : (
                    title
                )
            }
            outcome={outcome}
            pressable={onOpen !== undefined}
            busy={running}
        >
            {activity && (
                <Text id={activityId} variant="sm" color="secondary" truncate>
                    {activity}
                </Text>
            )}
            {text !== '' && (
                <div className={styles.report}>
                    {open.length > 0 && (
                        <Text variant="xs" color="secondary">
                            Not the final result
                        </Text>
                    )}
                    <Clamp lines={REPORT_LINES} moreLabel={MORE_LABEL} align="start">
                        <Markdown text={text} />
                    </Clamp>
                </div>
            )}
            {open.length > 0 && (
                <Text
                    variant="sm"
                    color="secondary"
                    className={styles.open}
                >{`Still running: ${open.join(', ')}`}</Text>
            )}
        </CardFrame>
    );
}

export interface ThreadMessageCardProps {
    /** The chat that wrote: a thread of the same tree, or the parent that started this thread (or this sub-agent). */
    chatId: ChatId;
    title: string;
    text: string;
    /** The stream item this message is, so the turn rail can scroll to it. */
    turn?: string;
}

/**
 * A message another chat of the thread tree wrote (`clowdy thread tell`, or the first message of a thread or of a sub-agent from its parent): an agent wrote it, not the
 * person, so it is a card in the family of the agent cards and not a bubble, marked with the agent of the chat that wrote it (Claude's mark for a Claude chat, as in the
 * list). The sender's name opens it; the words are Markdown as an agent's are, clamped when long.
 */
export function ThreadMessageCard({ chatId, title, text, turn }: ThreadMessageCardProps) {
    const { engineOfChat } = use(StreamLinksContext);

    return (
        <CardFrame
            slot="thread-message"
            icon={<AgentMark engine={engineOfChat?.(chatId)} />}
            title={
                <>
                    Message from <ChatName chatId={chatId} title={title} />
                </>
            }
            turn={turn}
        >
            {text.trim() !== '' && (
                <Clamp lines={MESSAGE_LINES} moreLabel={MORE_LABEL} align="start">
                    <Markdown text={text} />
                </Clamp>
            )}
        </CardFrame>
    );
}

/** One thread that stopped, as an agent's card: its name, how it ended, its last words. */
function NoticeCard({ notice }: { notice: ThreadNotice }) {
    const open = useOpenChat(notice.chatId);
    const title = useChatTitle(notice.chatId, notice.title);

    return (
        <AgentCard name={title} outcome={notice.outcome} report={notice.text} open={notice.background} onOpen={open} />
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
        <div role="group" aria-label="Threads that stopped" className={styles.group} data-turn={turn}>
            {threads.map(notice => (
                <NoticeCard key={notice.chatId} notice={notice} />
            ))}
        </div>
    );
}
