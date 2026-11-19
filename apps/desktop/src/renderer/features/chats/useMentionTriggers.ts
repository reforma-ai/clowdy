import { mainFolder } from '@clowdy/protocol';
import { useMemo, useRef, type RefObject } from 'react';

import { useProjectState, useRootStore } from '../../stores';
import { MENTION_TRIGGER, SKILL_TRIGGER } from './composerMentions';
import { docItems, docPaths, fileItems, FILES_SHOWN, skillItems, taskItems } from './mentionItems';

import type { RichInputTrigger, RichInputTriggerItem } from '@clowdy/components/RichInput';
import type { SkillEntry } from '@clowdy/protocol';

/** A source that is down leaves its part of the list empty; the others still answer. */
const orNothing = <T>(promise: Promise<T[]>): Promise<T[]> => promise.catch(() => []);

/**
 * The two pick lists of the message box. `@` offers the project's tasks, documents and files, `/` its skills. Both
 * open above the whole box, as wide as it is, and are searched as the person types.
 */
export function useMentionTriggers(box: RefObject<HTMLElement | null>): readonly RichInputTrigger[] {
    const root = useRootStore();
    const project = useProjectState();
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
            accessibilityLabel: 'Mention a task, document or file',
            ...menu,
            onSearch: async (query): Promise<RichInputTriggerItem[]> => {
                const main = mainFolder(project.project).id;
                const [docs, files] = await Promise.all([
                    orNothing(root.transport.getDocsTree(projectId).then(docPaths)),
                    // Only the main folder's files can be mentioned by a path the agent reads from its own folder.
                    orNothing(root.transport.getProjectFiles(projectId, query, FILES_SHOWN).then(found => found.filter(match => match.folderId === main).map(match => match.path))),
                ]);

                return [...taskItems(project.taskList, query), ...docItems(docs, query), ...fileItems(files)];
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
    }, [root, project, box]);
}
