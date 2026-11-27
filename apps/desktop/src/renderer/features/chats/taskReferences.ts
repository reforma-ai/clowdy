import type { ComposerMentionAttrs } from '@clowdy/components/RichInput';

export const TASK_REFERENCE_DRAG_TYPE = 'application/x-clowdy-task-reference';

export function droppedTaskReference(transfer: DataTransfer): ComposerMentionAttrs[] {
    try {
        const data: unknown = JSON.parse(transfer.getData(TASK_REFERENCE_DRAG_TYPE));
        if (
            !data ||
            typeof data !== 'object' ||
            !('key' in data) ||
            !('title' in data) ||
            typeof data.key !== 'string' ||
            !data.key ||
            typeof data.title !== 'string'
        )
            return [];
        return [
            {
                id: `task:${data.key}`,
                label: data.key,
                kind: 'task',
                trigger: '@',
                data: { key: data.key, title: data.title },
            },
        ];
    } catch {
        return [];
    }
}
