import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { useState } from 'react';

import { TaskChip } from '../../shared';
import styles from './ProgressCard.module.css';

import type { ChatProgress } from './progress';

/** Chips shown before "+N more": a chat can plan dozens of tasks. */
const VISIBLE_CHIPS = 12;

/** "Implementation · 3 of 8 tasks done": a bar, and the tasks as chips that open them. */
export function ProgressCard({ progress }: { progress: ChatProgress }) {
    const [expanded, setExpanded] = useState(false);
    const { done, total, tasks } = progress;
    const shown = expanded ? tasks : tasks.slice(0, VISIBLE_CHIPS);

    return (
        <section className={ styles.card } aria-label="Progress">
            <Text bold>{ `Implementation · ${ done } of ${ total } ${ total === 1 ? 'task' : 'tasks' } done` }</Text>

            <div
                className={ styles.track }
                role="progressbar"
                aria-label="Tasks done"
                aria-valuemin={ 0 }
                aria-valuemax={ total }
                aria-valuenow={ done }
            >
                <div className={ styles.fill } style={ { width: `${ (done / total) * 100 }%` } } />
            </div>

            <div className={ styles.chips }>
                { shown.map(task => <TaskChip key={ task.id } task={ task } />) }
                { tasks.length > VISIBLE_CHIPS && (
                    <Button variant="filling" color="secondary" size="xs" onPress={ () => setExpanded(!expanded) }>
                        { expanded ? 'Show fewer' : `+${ tasks.length - VISIBLE_CHIPS } more` }
                    </Button>
                ) }
            </div>
        </section>
    );
}
