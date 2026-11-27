import { Chip } from '@clowdy/components/Chip';
import { Text, type TextColor } from '@clowdy/components/Text';
import { BackgroundTask, Completed, Eye, TaskCanceled, TaskPlaned, TaskPlaned2 } from '@clowdy/icons/14';

import styles from './status.module.css';

import type { TaskStatus, TaskStatusCategory } from '@clowdy/protocol';
import type { ComponentType, SVGProps } from 'react';
import type { StatusTone } from '../../shared';

const CATEGORY_VIEW: Record<TaskStatusCategory, { icon: ComponentType<SVGProps<SVGSVGElement>>; tone: StatusTone }> = {
    backlog: { icon: TaskPlaned, tone: 'neutral' },
    todo: { icon: TaskPlaned2, tone: 'neutral' },
    active: { icon: BackgroundTask, tone: 'accent' },
    review: { icon: Eye, tone: 'warning' },
    done: { icon: Completed, tone: 'success' },
    canceled: { icon: TaskCanceled, tone: 'neutral' },
};

export function statusTone(category?: TaskStatusCategory): StatusTone {
    return category ? CATEGORY_VIEW[category].tone : 'neutral';
}

/** The text colour of a tone: a neutral status is the muted one. */
const toneColor = (tone: StatusTone): TextColor => (tone === 'neutral' ? 'secondary' : tone);

/** The icon of a status category, in the category's color: dashed circle, circle, progress, eye, check, cancelled. */
export function StatusIcon({ category, size = 14 }: { category: TaskStatusCategory; size?: number }) {
    const { icon: Icon, tone } = CATEGORY_VIEW[category];

    return (
        <Text aria-hidden className={styles.icon} color={toneColor(tone)} data-tone={tone}>
            <Icon width={size} height={size} />
        </Text>
    );
}

/** A status as a pill with its icon, and a count after the name when given. A status the workflow no longer has shows as "Unknown". */
export function StatusPill({ status, count }: { status: TaskStatus | undefined; count?: number }) {
    return (
        <Chip
            shape="pill"
            tone={statusTone(status?.category)}
            icon={status && <StatusIcon category={status.category} />}
        >
            {status?.name ?? 'Unknown'}
            {count !== undefined && <span className={styles.count}>{count}</span>}
        </Chip>
    );
}
