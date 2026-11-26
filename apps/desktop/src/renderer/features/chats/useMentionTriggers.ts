import { type RefObject, useMemo, useRef } from 'react';

import { useProjectState, useRootStore } from '../../stores';
import { isPlaceReady, type Place } from '../sidePanel/currentPlace';
import { MENTION_TRIGGER, SKILL_TRIGGER } from './composerMentions';
import { chatItems, docItems, FILES_SHOWN, fileItems, skillItems, taskItems } from './mentionItems';

import type { RichInputTrigger, RichInputTriggerItem } from '@clowdy/components/RichInput';
import type { SkillEntry } from '@clowdy/protocol';

/** A source that is down leaves its part of the list empty; the others still answer. */
const orNothing = <T>(promise: Promise<T[]>): Promise<T[]> => promise.catch(() => []);

/**
 * The two pick lists of the message box. `@` offers the project's tasks, chats, documents and files, `/` its skills. Both
 * open above the whole box, as wide as it is, and are searched as the person types. The documents and files are those of the box's `place`, the ones the Files and Docs tabs show
 * for it: the worktree's for a chat that works in one (and none while the worktree is not made yet: it has no files), the folder's own checkout's otherwise. A path that is picked
 * is the one the agent reads from its working directory: relative for the place's own folder, absolute for another folder of the project.
 */
export function useMentionTriggers(
    box: RefObject<HTMLElement | null>,
    place: Place,
    currentChatId?: string
): readonly RichInputTrigger[] {
    const root = useRootStore();
    const project = useProjectState();
    // The ids and the state of the place, not the object, which is made again on every draw of the box.
    const folderId = place.folder.id;
    const workspaceId = place.workspace?.id;
    const ready = isPlaceReady(place);
    // The catalog is read from disk by the daemon: once per change to the skills, not once per key.
    const skills = useRef<{ revision: number; entries: Promise<SkillEntry[]> } | null>(null);

    return useMemo(() => {
        const projectId = project.project.id;
        const menu = { placement: 'top' as const, getAnchorRect: () => box.current?.getBoundingClientRect() ?? null };

        const catalog = () => {
            if (skills.current?.revision !== root.skillsRevision) {
                const entries = root.transport.getSkills(projectId).then(found => found.entries);

                skills.current = { revision: root.skillsRevision, entries };
                // A catalog that could not be read is asked for again with the next key, not kept until the skills change.
                entries.catch(() => {
                    if (skills.current?.entries === entries) skills.current = null;
                });
            }

            return orNothing(skills.current.entries);
        };

        const mention: RichInputTrigger = {
            char: MENTION_TRIGGER,
            position: 'any',
            accessibilityLabel: 'Mention a task, chat, document or file',
            ...menu,
            onSearch: async (query): Promise<RichInputTriggerItem[]> => {
                const { folders } = project.project;
                // A worktree that is not made yet has no files and no documents to list, and the folder's own checkout is not what the chat works in.
                const [docs, files] = ready
                    ? await Promise.all([
                          orNothing(
                              root.transport
                                  .getDocsTree(projectId, workspaceId)
                                  .then(tree => docItems(tree, folders, query, folderId))
                          ),
                          orNothing(
                              root.transport
                                  .getProjectFiles(projectId, query, FILES_SHOWN, workspaceId)
                                  .then(found => fileItems(found, folders, folderId))
                          ),
                      ])
                    : [[], []];

                return [
                    ...taskItems(project.taskList, query, project.statuses),
                    ...chatItems(project.chatList, query, currentChatId),
                    ...docs,
                    ...files,
                ];
            },
        };

        const skill: RichInputTrigger = {
            char: SKILL_TRIGGER,
            position: 'any',
            accessibilityLabel: 'Ask for a skill',
            ...menu,
            onSearch: async query => skillItems(await catalog(), query),
        };

        return [mention, skill];
    }, [root, project, box, folderId, workspaceId, ready, currentChatId]);
}
