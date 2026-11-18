import { Button } from '@clowdy/components/Button';
import { OverlayTriggerStateContext, Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { use, useState } from 'react';

import { useAgents, useRootStore } from '../../stores';
import { isRunActive } from './chatRun';
import { perform } from './commands';
import styles from './ContextRing.module.css';
import { contextFill, type ContextFill } from './contextUsage';
import { Unavailable } from './Unavailable';

import type { Chat, Run } from '@clowdy/protocol';

/** Why Compact is off while the orchestrator works: the agent's command is a turn of its own, which the daemon refuses to start on a busy chat. */
const BUSY_HINT = 'Wait until the agent has finished';

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
    // A chat from before it had a provider of its own takes its orchestrator's.
    const canCompact = agents.find(agent => agent.id === (chat.engine ?? run.engine))?.canCompact === true;

    return (
        <PopoverTrigger>
            <Button variant="filling" size="sm" rounded iconOnly aria-label={ `Context usage, ${ fill.label }` }>
                <Ring fill={ fill } />
            </Button>
            <Popover placement="top" spacing="none" width={ 280 } aria-label="Context usage">
                <ContextPanel chat={ chat } fill={ fill } running={ isRunActive(run) } canCompact={ canCompact } />
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
    /** The orchestrator works: Compact would be refused. */
    running: boolean;
    canCompact: boolean;
}

/** The popover: one total (no split into instructions, tools and conversation) and the way to shrink it. */
function ContextPanel({ chat, fill, running, canCompact }: PanelProps) {
    const root = useRootStore();
    const overlay = use(OverlayTriggerStateContext);
    const [isPending, setIsPending] = useState(false);

    // The daemon's refusal (busy, unread results from the executors) is the usual toast; the popover closes either way, the toast says what happened.
    const compact = async () => {
        setIsPending(true);

        try {
            await perform(root, { type: 'chat.compact', chatId: chat.id });
        }
        finally {
            setIsPending(false);
            overlay?.close();
        }
    };

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
                { /* The hint opens below the button: above it would cover the readout. */ }
                <Unavailable label="Compact" hint={ running ? BUSY_HINT : undefined } placement="bottom">
                    <Button variant="bordered" color="secondary" size="sm" fullWidth isDisabled={ running } isPending={ isPending } onPress={ () => void compact() }>
                        Compact
                    </Button>
                </Unavailable>
            </Show>
        </div>
    );
}
