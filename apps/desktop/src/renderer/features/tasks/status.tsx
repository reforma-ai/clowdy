import { BackgroundTask, Completed, Eye, TaskCanceled, TaskPlaned, TaskPlaned2 } from '@clowdy/icons/14';

import { Pill, PillLabel, type PillTone } from './Pill';
import styles from './status.module.css';

import type { TaskStatus, TaskStatusCategory } from '@clowdy/protocol';
import type { ComponentType, SVGProps } from 'react';

const CATEGORY_VIEW: Record<TaskStatusCategory, { icon: ComponentType<SVGProps<SVGSVGElement>>; tone: PillTone }> = {
    backlog: { icon: TaskPlaned, tone: 'neutral' },
    todo: { icon: TaskPlaned2, tone: 'neutral' },
    active: { icon: BackgroundTask, tone: 'accent' },
    review: { icon: Eye, tone: 'warning' },
    done: { icon: Completed, tone: 'success' },
    canceled: { icon: TaskCanceled, tone: 'neutral' },
};

/** The icon of a status category, in the category's color: dashed circle, circle, progress, eye, check, cancelled. */
export function StatusIcon({ category }: { category: TaskStatusCategory }) {
    const { icon: Icon, tone } = CATEGORY_VIEW[category];

    return (
        <span aria-hidden className={ styles.icon } data-tone={ tone }>
            <Icon />
        </span>
    );
}

/** A status as a pill with its icon, and a count after the name when given. A status the workflow no longer has shows as "Unknown". */
export function StatusPill({ status, count }: { status: TaskStatus | undefined; count?: number }) {
    return (
        <Pill tone={ status ? CATEGORY_VIEW[status.category].tone : 'neutral' }>
            { status && <StatusIcon category={ status.category } /> }
            <PillLabel>{ status?.name ?? 'Unknown' }</PillLabel>
            { count !== undefined && <span className={ styles.count }>{ count }</span> }
        </Pill>
    );
}
