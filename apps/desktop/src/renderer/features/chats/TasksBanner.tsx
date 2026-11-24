import { Text } from '@clowdy/components/Text';
import { useState } from 'react';

import { useProjectState, useProjectUi } from '../../stores';
import { StatusPill } from '../tasks/status';
import { ComposerBanner, ComposerBannerHeader } from './ComposerBanner';
import styles from './TasksBanner.module.css';

import type { ChatProgress } from './progress';

/** The chat's current tasks, kept outside the message history. */
export function TasksBanner({ progress }: { progress: ChatProgress }) {
    const [expanded, setExpanded] = useState(false);
    const project = useProjectState();
    const ui = useProjectUi();
    const { done, total, tasks } = progress;

    return (
        <ComposerBanner role="group" aria-label="Chat tasks">
            <ComposerBannerHeader
                expanded={expanded}
                onPress={() => setExpanded(!expanded)}
                summary={
                    <>
                        <span className={styles.track} aria-hidden>
                            <span className={styles.fill} style={{ width: `${(done / total) * 100}%` }} />
                        </span>
                        <Text variant="xs" color="secondary">{`${done} of ${total}`}</Text>
                    </>
                }
            >
                Tasks
            </ComposerBannerHeader>
            {expanded && (
                <div className={styles.list}>
                    {tasks.map(task => (
                        <button type="button" className={styles.row} key={task.id} onClick={() => ui.openTask(task.id)}>
                            <span className={styles.key}>{task.key}</span>
                            <span className={styles.title}>{task.title}</span>
                            <StatusPill status={project.statuses.find(status => status.id === task.statusId)} />
                        </button>
                    ))}
                </div>
            )}
        </ComposerBanner>
    );
}
