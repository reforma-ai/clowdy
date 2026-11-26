import { Textarea } from '@clowdy/components/Textarea';
import { toast } from '@clowdy/components/Toast';
import { useState } from 'react';

import { Unavailable } from '../../shared/Unavailable';
import { useRunLabel } from '../../shared/useRunLabel';
import { useProjectState, useRootStore } from '../../stores';
import composer from './Composer.module.css';
import { ComposerSend } from './ComposerSend';
import { isRunActive } from './chatRun';
import { canStopAlone } from './runningAgentRows';
import styles from './SubagentBox.module.css';

import type { Run } from '@clowdy/protocol';

/** What the box says while nothing is wrong: the daemon has no way to write to a native sub-agent, so the person cannot, and only its parent can. */
const ONLY_PARENT = 'Only its parent can write to this sub-agent';

const noop = () => {};

/**
 * The message box of a native sub-agent's page: the composer's own card, with no field to type in and no model or mode. It says that only the sub-agent's parent can write to
 * it. While the sub-agent works, Stop stands where Send does when its session can end it alone (`Run.canStopAlone`) and ends that sub-agent only; one that cannot be
 * stopped alone says where it runs instead, since only its parent's Stop ends it. At rest there is nothing to press.
 */
export function SubagentBox({ run }: { run: Run }) {
    const root = useRootStore();
    const project = useProjectState();
    const label = useRunLabel();
    const [isStopping, setIsStopping] = useState(false);
    const parent = run.parentRunId ? project.runs.get(run.parentRunId) : undefined;
    const working = isRunActive(run);
    const stoppable = working && canStopAlone(run);
    // A sub-agent lives inside its parent's session: when that session cannot end it alone, the daemon refuses to stop it.
    const hint = working && !stoppable ? `Runs inside ${parent ? label(parent) : 'its parent'}` : ONLY_PARENT;

    const stop = async () => {
        setIsStopping(true);

        const result = await root.command({ type: 'run.cancel', runId: run.id });

        setIsStopping(false);

        if (!result.ok) toast.error({ message: `Could not stop ${label(run)}: ${result.error.message}` });
    };

    return (
        <div className={composer.surface} data-disabled>
            <Textarea
                variant="inline"
                rows={1}
                isResizable={false}
                isDisabled
                aria-label="Message"
                placeholder={hint}
                className={styles.field}
            />

            <div className={composer.row}>
                <div className={composer.start} />

                <div className={composer.end}>
                    {stoppable ? (
                        <ComposerSend
                            canSend={false}
                            running
                            isStopping={isStopping}
                            onSend={noop}
                            onStop={() => void stop()}
                        />
                    ) : (
                        <Unavailable label="Send" hint={hint}>
                            <ComposerSend
                                canSend={false}
                                running={false}
                                isStopping={false}
                                onSend={noop}
                                onStop={noop}
                            />
                        </Unavailable>
                    )}
                </div>
            </div>
        </div>
    );
}
