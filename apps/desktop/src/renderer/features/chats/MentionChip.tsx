import { FileIcon } from '@clowdy/components/FileIcon';
import { Message, Page } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import chipStyles from '../../shared/Chip.module.css';
import { TaskChipContents, taskChipClass } from '../../shared/TaskChip';
import { useProjectState } from '../../stores';
import { statusTone } from '../tasks/status';
import styles from './MentionChip.module.css';

import type { ComposerMentionAttrs, RichInputMentionRenderProps } from '@clowdy/components/RichInput';
import type { ReactNode } from 'react';

const ICON_SIZE = 12;

/** The mark of a chat, document or file mention. Task mentions follow their current status. */
export function mentionIcon({ kind, data }: Pick<ComposerMentionAttrs, 'kind' | 'data'>, size = ICON_SIZE): ReactNode {
    switch (kind) {
        case 'chat':
            return <Message width={size} height={size} />;
        case 'doc':
            return <Page width={size} height={size} />;
        case 'file': {
            const { path, directory } = (data ?? {}) as { path?: unknown; directory?: unknown };

            // A folder pasted from Finder or the tree is a chip of this kind too.
            return <FileIcon path={String(path ?? '')} kind={directory === true ? 'directory' : 'file'} />;
        }
        default:
            return null;
    }
}

function TaskMentionChip({ mention }: Pick<RichInputMentionRenderProps, 'mention'>) {
    const project = useProjectState();
    const task = project.taskOfKey(mention.label);
    const status = project.statuses.find(candidate => candidate.id === task?.statusId);
    const title = task?.title ?? (mention.data as { title?: string } | null)?.title;

    return (
        <span
            className={cn(taskChipClass, styles.chip)}
            data-chip
            data-tone={statusTone(status?.category)}
            title={title}
        >
            <TaskChipContents label={mention.label} status={status} />
        </span>
    );
}

/** A skill asked for in a message that was sent: the plate it had in the box, with its description as the hover title. */
export function SkillChip({ name, description }: { name: string; description?: string }) {
    return (
        <span className={cn(chipStyles.chip, styles.chip)} data-chip title={description}>
            <span className={chipStyles.label}>{`/${name}`}</span>
        </span>
    );
}

/** A mention inside the text: the same plate as a task chip in the chat, with what it points at as its hover title. */
export function MentionChip({ mention }: RichInputMentionRenderProps) {
    if (mention.kind === 'task') return <TaskMentionChip mention={mention} />;

    const title =
        (mention.data as { title?: unknown; path?: unknown } | null)?.title ??
        (mention.data as { path?: unknown } | null)?.path;
    const icon = mentionIcon(mention);

    return (
        <span
            className={cn(chipStyles.chip, styles.chip)}
            data-chip
            title={typeof title === 'string' ? title : undefined}
        >
            {icon && <span className={chipStyles.icon}>{icon}</span>}
            <span className={chipStyles.label}>{mention.label}</span>
        </span>
    );
}
