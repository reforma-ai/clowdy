import type { ChatId } from '@clowdy/protocol';
import type { ProjectUi } from '../../stores';
import type { ScrollMemory, ScrollPosition } from '../../stream/scrollPosition';

/** Reading positions belong to a project's live UI session, not to its durable settings. */
const positions = new WeakMap<ProjectUi, Map<ChatId, ScrollPosition>>();

export function chatScrollMemory(ui: ProjectUi, chatId: ChatId): ScrollMemory {
    let project = positions.get(ui);

    if (!project) {
        project = new Map();
        positions.set(ui, project);
    }

    return {
        read: () => project.get(chatId),
        write: position => {
            if (position) project.set(chatId, position);
            else project.delete(chatId);
        },
    };
}
