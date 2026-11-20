import { Button } from '@clowdy/components/Button';
import { OverlayTriggerStateContext, Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { use } from 'react';

import { useAgents } from '../../stores';
import { canCompactChat } from './chatProvider';
import { isRunActive } from './chatRun';
import styles from './ContextRing.module.css';
import { contextFill, type ContextFill } from './contextUsage';
import { Unavailable } from './Unavailable';
import { useCompact } from './useCompact';

import type { Chat, Run } from '@clowdy/protocol';

/** Why Compact is off: the person asked for it already, and it waits in the chat's queue for the agent to finish. */
const QUEUED_HINT = 'Compact is in the queue';

export interface ContextRingProps {
    /** The chat the composer writes to. The new-chat page has none, and no context to show. */
    chat: Chat | undefined;
    /** The chat's orchestrator, which carries the latest reading of the context window (`run.context`). */
    run: Run | undefined;
}

/**
 * How full the chat's context window is, as a small ring in the message box that opens a popover with the total and, for an agent that
 * can, a Compact button. The agent reports the reading with every message and the daemon keeps it on the orchestrator's run, so the ring
 * follows the run as it changes and a finished chat still shows its last one. Nothing is drawn without a reading: a new chat, and an agent
 * that reports none (Cursor).
 */
export function ContextRing({ chat, run }: ContextRingProps) {
    const { agents } = useAgents();

    if (!chat || !run?.context) return null;

    const fill = contextFill(run.context);

    const label = `Context usage, ${ fill.label }`;

    return (
        <PopoverTrigger>
            { /*
               * The ring is only an arc, so a tooltip says what it is and how full. It sits below the ring and goes away at a press
               * (`shouldCloseOnPress`, which the design system's tooltip leaves off by default): the popover opens above the ring, and a
               * tooltip left standing, or one still waiting for its delay, would be drawn over it.
               */ }
            <Tooltip content={ label } placement="bottom" shouldCloseOnPress>
                <Button variant="filling" size="sm" rounded iconOnly aria-label={ label }>
                    <Ring fill={ fill } />
                </Button>
            </Tooltip>
            <Popover placement="top" spacing="none" width={ 280 } aria-label="Context usage">
                <ContextPanel chat={ chat } fill={ fill } running={ isRunActive(run) } canCompact={ canCompactChat(chat, run, agents) } />
            </Popover>
        </PopoverTrigger>
    );
}

/** The percent full as an arc from the top, clockwise, over a track. The path is 100 long, so the dash is the percent. */
function Ring({ fill }: { fill: ContextFill }) {
    return (
        <svg className={ styles.ring } data-tone={ fill.tone } viewBox="0 0 18 18" width={ 18 } height={ 18 } aria-hidden="true">
            <circle className={ styles.track } cx="9" cy="9" r="8" />
            <Show when={ fill.percent > 0 }>
                <circle
                    className={ styles.arc }
                    cx="9"
                    cy="9"
                    r="8"
                    pathLength={ 100 }
                    strokeDasharray={ `${ fill.percent } ${ 100 - fill.percent }` }
                    transform="rotate(-90 9 9)"
                />
            </Show>
        </svg>
    );
}

interface PanelProps {
    chat: Chat;
    fill: ContextFill;
    /** The orchestrator has not finished: Compact joins the chat's queue and runs once it has, unless the queue is held. */
    running: boolean;
    canCompact: boolean;
}

/** The popover: one total (no split into instructions, tools and conversation) and the way to shrink it. */
function ContextPanel({ chat, fill, running, canCompact }: PanelProps) {
    const overlay = use(OverlayTriggerStateContext);
    const { compact, isPending } = useCompact(chat.id);
    // Asked for while the agent worked: it waits in the queue, and asking again would change nothing.
    const queued = chat.queue?.some(item => item.command === 'compact') === true;

    return (
        <div className={ styles.panel }>
            <Text variant="heading-6">Context usage</Text>

            <div className={ styles.figures }>
                <div className={ styles.readout }>
                    <Text variant="sm">{ fill.label }</Text>
                    <Text variant="sm" color="secondary" whitespace="nowrap">{ `${ fill.used } / ${ fill.size }` }</Text>
                </div>

                <div className={ styles.bar } data-tone={ fill.tone } role="meter" aria-label="Context used" aria-valuemin={ 0 } aria-valuemax={ 100 } aria-valuenow={ fill.percent } aria-valuetext={ fill.label }>
                    <div className={ styles.fill } style={ { width: `${ fill.percent }%` } } />
                </div>
            </div>

            <Show when={ canCompact }>
                <div className={ styles.compact }>
                    { /* The hint opens below the button: above it would cover the readout. */ }
                    <Unavailable label="Compact" hint={ queued ? QUEUED_HINT : undefined } placement="bottom">
                        { /* The daemon's refusal, if any, is the usual toast; the popover closes either way. */ }
                        <Button
                            variant="bordered"
                            color="secondary"
                            size="sm"
                            fullWidth
                            isDisabled={ queued }
                            isPending={ isPending }
                            onPress={ () => void compact().finally(() => overlay?.close()) }
                        >
                            Compact
                        </Button>
                    </Unavailable>

                    { /* A held queue (after a Stop or a failure) gives nothing by itself when the agent finishes: the person sends from it. */ }
                    <Show when={ running && !queued }>
                        <Text variant="xs" color="secondary" align="center">
                            { chat.queuePaused ? 'Joins the paused queue. Use Send now on it once the agent finishes.' : 'Waits in the queue until the agent finishes' }
                        </Text>
                    </Show>
                </div>
            </Show>
        </div>
    );
}
