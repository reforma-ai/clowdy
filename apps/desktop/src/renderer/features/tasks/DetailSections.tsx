import { Button } from '@clowdy/components/Button';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { Box, CodeBraces, Commit, Message, Page, Terminal, Tool, User } from '@clowdy/icons/14';
import { type ComponentType, type ReactNode, type SVGProps, useEffect, useState } from 'react';

import { RunStatusPill, useRunLabel } from '../../shared';
import { AgentAvatar } from '../../stream';
import styles from './DetailSections.module.css';
import { Pill, PillLabel } from './Pill';
import { type Activity, formatAgo, type ResultRow, resultRows } from './taskView';
import { useTaskArtifacts } from './useTaskArtifacts';

import type { Artifact, Chat, Run, TaskId } from '@clowdy/protocol';

export interface SectionProps {
    title: string;
    /** Shown after the title when it is above zero. */
    count?: number;
    /** What else the header says, after the title and the count: a roll-up chip. */
    aside?: ReactNode;
    children: ReactNode;
}

export function Section({ title, count, aside, children }: SectionProps) {
    return (
        <section className={styles.section}>
            <div className={styles.head}>
                <Text variant="heading-6">{title}</Text>
                {count !== undefined && count > 0 && <span className={styles.badge}>{count}</span>}
                {aside}
            </div>
            {children}
        </section>
    );
}

/** The line a section says when it has nothing to list. */
export const None = ({ children }: { children: ReactNode }) => <span className={styles.none}>{children}</span>;

/** The agents on the task, each with its status. A press selects the run in Agents. */
export function Executors({ taskRuns, onOpen }: { taskRuns: readonly Run[]; onOpen: (runId: string) => void }) {
    const labelOf = useRunLabel();

    return (
        <Section title="Executors" count={taskRuns.length}>
            {taskRuns.length === 0 ? (
                <None>No agent has worked on this task yet</None>
            ) : (
                <div className={styles.rows}>
                    {taskRuns.map(run => (
                        <button
                            key={run.id}
                            type="button"
                            className={styles.row}
                            onClick={() => onOpen(run.id)}
                            title={labelOf(run)}
                        >
                            <span aria-hidden className={styles.icon}>
                                <User />
                            </span>
                            <span className={styles.rowText}>
                                <span className={styles.rowName}>{labelOf(run)}</span>
                            </span>
                            <RunStatusPill run={run} />
                        </button>
                    ))}
                </div>
            )}
        </Section>
    );
}

/** The chats that discuss the task. A press opens the chat. */
export function RelatedChats({ chats, onOpen }: { chats: readonly Chat[]; onOpen: (chatId: string) => void }) {
    return (
        <Section title="Related chats" count={chats.length}>
            {chats.length === 0 ? (
                <None>No chat is linked to this task</None>
            ) : (
                <div className={styles.rows}>
                    {chats.map(chat => (
                        <button key={chat.id} type="button" className={styles.row} onClick={() => onOpen(chat.id)}>
                            <span aria-hidden className={styles.icon}>
                                <Message />
                            </span>
                            <span className={styles.rowText}>
                                <span className={styles.rowTitle}>{chat.title}</span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </Section>
    );
}

const RESULT_ICONS: Record<Artifact['kind'], ComponentType<SVGProps<SVGSVGElement>>> = {
    diff: CodeBraces,
    commit: Commit,
    check: Terminal,
    doc: Page,
    build: Tool,
};

function ResultContent({ row }: { row: ResultRow }) {
    const Icon = RESULT_ICONS[row.kind];

    return (
        <>
            <span aria-hidden className={styles.icon}>
                <Icon />
            </span>
            <span className={styles.rowText}>
                <span className={styles.rowTitle}>{row.title}</span>
            </span>
            {row.meta && <span className={styles.meta}>{row.meta}</span>}
            {row.verdict && (
                <Pill tone={row.verdict.tone}>
                    <PillLabel>{row.verdict.label}</PillLabel>
                </Pill>
            )}
        </>
    );
}

/** What the task produced: changes, commits, checks, documents. A document opens on the Docs tab. */
export function Results({
    taskId,
    expectChecks,
    onOpenDoc,
}: {
    taskId: TaskId;
    expectChecks: boolean;
    onOpenDoc: (path: string) => void;
}) {
    const { state, retry } = useTaskArtifacts(taskId);
    const rows = state.status === 'ready' ? resultRows(state.artifacts, { expectChecks }) : [];

    return (
        <Section title="Results" count={rows.length}>
            {state.status === 'loading' && <Spinner size="sm" aria-label="Loading results" />}
            {state.status === 'failed' && (
                <div className={styles.failed}>
                    <None>Results did not load</None>
                    <Button size="xs" variant="bordered" onPress={retry}>
                        Retry
                    </Button>
                </div>
            )}
            {state.status === 'ready' && rows.length === 0 && (
                <None>Nothing yet. Changes and checks show up here.</None>
            )}
            {rows.length > 0 && (
                <div className={styles.rows}>
                    {rows.map(row =>
                        row.docPath ? (
                            <button
                                key={row.id}
                                type="button"
                                className={styles.row}
                                onClick={() => onOpenDoc(row.docPath as string)}
                            >
                                <ResultContent row={row} />
                            </button>
                        ) : (
                            <div key={row.id} className={styles.row}>
                                <ResultContent row={row} />
                            </div>
                        )
                    )}
                </div>
            )}
        </Section>
    );
}

/** A minute-resolution clock for "2 minutes ago". */
function useNow(): number {
    const [now, setNow] = useState(Date.now);

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);

        return () => clearInterval(timer);
    }, []);

    return now;
}

/** The newest things that happened to the task. */
export function LatestActivity({ activity }: { activity: readonly Activity[] }) {
    const now = useNow();

    return (
        <Section title="Latest activity">
            {activity.map(event => (
                <div key={event.id} className={styles.activity}>
                    {event.run ? (
                        <AgentAvatar role={event.run.role} />
                    ) : (
                        <span aria-hidden className={styles.eventIcon}>
                            <Box />
                        </span>
                    )}
                    <div className={styles.event}>
                        <span className={styles.eventText}>{event.text}</span>
                        {event.detail && <span className={styles.eventDetail}>{event.detail}</span>}
                        <span className={styles.eventTime}>{formatAgo(event.at, now)}</span>
                    </div>
                </div>
            ))}
        </Section>
    );
}
