import { Chip } from '@clowdy/components/Chip';
import { FileIcon } from '@clowdy/components/FileIcon';
import { Message, Page } from '@clowdy/icons/14';

import { taskChipIcon } from '../../shared/TaskChip';
import { useProjectState } from '../../stores';
import { statusTone } from '../tasks/status';

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

/** A task mention: the task chip of the chat, out of the tab order since it is part of the text. */
function TaskMentionChip({ mention }: Pick<RichInputMentionRenderProps, 'mention'>) {
    const project = useProjectState();
    const task = project.taskOfKey(mention.label);
    const status = project.statuses.find(candidate => candidate.id === task?.statusId);
    const title = task?.title ?? (mention.data as { title?: string } | null)?.title;

    return (
        <Chip tone={statusTone(status?.category)} icon={taskChipIcon(status)} tooltip={title} data-chip tabIndex={-1}>
            {mention.label}
        </Chip>
    );
}

/** A skill asked for in a message that was sent: the plate it had in the box, with its description as the hover title. */
export function SkillChip({ name, description }: { name: string; description?: string }) {
    return (
        <Chip data-chip title={description}>
            {`/${name}`}
        </Chip>
    );
}

/**
 * A mention inside the text: the same plate as a task chip in the chat, with what it points at as its hover title. A native title, since a chip with a tooltip
 * would be a stop of its own inside the text.
 */
export function MentionChip({ mention }: RichInputMentionRenderProps) {
    if (mention.kind === 'task') return <TaskMentionChip mention={mention} />;

    const title =
        (mention.data as { title?: unknown; path?: unknown } | null)?.title ??
        (mention.data as { path?: unknown } | null)?.path;

    return (
        <Chip data-chip icon={mentionIcon(mention)} title={typeof title === 'string' ? title : undefined}>
            {mention.label}
        </Chip>
    );
}
