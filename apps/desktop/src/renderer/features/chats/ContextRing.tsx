import { Button } from '@clowdy/components/Button';
import { Show } from '@clowdy/components/Show';
import { Tooltip } from '@clowdy/components/Tooltip';

import { useAgents } from '../../stores';
import styles from './ContextRing.module.css';
import { canCompactChat } from './chatProvider';
import { type ContextFill, contextFill } from './contextUsage';
import { useCompact } from './useCompact';

import type { Chat, Run } from '@clowdy/protocol';

export interface ContextRingProps {
    /** The chat the composer writes to. The new-chat page has none, and no context to show. */
    chat: Chat | undefined;
    /** The chat's orchestrator, which carries the latest reading of the context window (`run.context`). */
    run: Run | undefined;
}

/** The context reading appears on hover or focus. Pressing the ring requests compaction when the agent supports it. */
export function ContextRing({ chat, run }: ContextRingProps) {
    const { agents } = useAgents();

    if (!chat || !run?.context) return null;

    const fill = contextFill(run.context);

    return (
        <Tooltip content={<ContextReadout fill={fill} />} placement="bottom" shouldCloseOnPress>
            {canCompactChat(chat, run, agents) ? (
                <CompactRing chat={chat} fill={fill} />
            ) : (
                <span
                    className={styles.readOnly}
                    data-context-ring=""
                    role="button"
                    aria-disabled
                    tabIndex={0}
                    aria-label={`Context usage, ${fill.label}`}
                >
                    <Ring fill={fill} />
                </span>
            )}
        </Tooltip>
    );
}

function CompactRing({ chat, fill }: { chat: Chat; fill: ContextFill }) {
    const { compact, isPending } = useCompact(chat.id);
    const queued = chat.queue?.some(item => item.command === 'compact') === true;

    return (
        <Button
            variant="filling"
            size="xs"
            rounded
            iconOnly
            data-context-ring=""
            aria-label={`${queued ? 'Compact context queued' : 'Compact context'}, ${fill.label}`}
            isPending={isPending || queued}
            spinnerPlacement={queued ? 'none' : 'center'}
            onPress={() => void compact()}
        >
            <Ring fill={fill} />
        </Button>
    );
}

/** The percent full as an arc from the top, clockwise, over a track. The path is 100 long, so the dash is the percent. */
function Ring({ fill }: { fill: ContextFill }) {
    return (
        <svg
            className={styles.ring}
            data-tone={fill.tone}
            viewBox="0 0 18 18"
            width={12}
            height={12}
            aria-hidden="true"
        >
            <circle className={styles.track} cx="9" cy="9" r="8" />
            <Show when={fill.percent > 0}>
                <circle
                    className={styles.arc}
                    cx="9"
                    cy="9"
                    r="8"
                    pathLength={100}
                    strokeDasharray={`${fill.percent} ${100 - fill.percent}`}
                    transform="rotate(-90 9 9)"
                />
            </Show>
        </svg>
    );
}

function ContextReadout({ fill }: { fill: ContextFill }) {
    return (
        <div className={styles.figures}>
            <div className={styles.readout}>
                <span>{fill.label}</span>
                <span>{`${fill.used} / ${fill.size}`}</span>
            </div>
            <div
                className={styles.bar}
                data-tone={fill.tone}
                role="meter"
                aria-label="Context used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={fill.percent}
                aria-valuetext={fill.label}
            >
                <div className={styles.fill} style={{ width: `${fill.percent}%` }} />
            </div>
        </div>
    );
}
