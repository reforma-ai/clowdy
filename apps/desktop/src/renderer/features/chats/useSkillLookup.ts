import { useCallback, useEffect, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';
import { skillName } from './mentionItems';

import type { SkillEntry } from '@clowdy/protocol';
import type { StreamLinks } from '../../stream/StreamLinks';

/**
 * The skills a message may ask for, by the name an agent knows them by: the user's and the project's, switched on or off (a message that asked for
 * one still names it). The system ones belong to the orchestrator. The catalog is read again when the daemon announces `skills.changed`; one that cannot
 * be read leaves the messages as written.
 */
export function useSkillLookup(): NonNullable<StreamLinks['skillOfName']> {
    const root = useRootStore();
    const projectId = useProjectState().id;
    const { skillsRevision } = root;
    const [skills, setSkills] = useState<ReadonlyMap<string, SkillEntry>>(new Map());

    useEffect(() => {
        let current = true;

        root.transport.getSkills(projectId).then(
            catalog => {
                if (!current) return;

                const named = new Map<string, SkillEntry>();

                for (const entry of catalog.entries) {
                    if (entry.source !== 'system' && !named.has(skillName(entry))) named.set(skillName(entry), entry);
                }

                setSkills(named);
            },
            () => current && setSkills(new Map())
        );

        return () => {
            current = false;
        };
    }, [root, projectId, skillsRevision]);

    return useCallback((name: string) => skills.get(name), [skills]);
}
