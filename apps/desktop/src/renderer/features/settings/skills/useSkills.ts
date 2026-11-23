import { toast } from '@clowdy/components/Toast';
import { useCallback, useEffect, useState } from 'react';

import { useRootStore } from '../../../stores';

import type { ProjectId, SkillCatalog, SkillEntry } from '@clowdy/protocol';

export type SkillsState =
    | { status: 'loading' }
    | { status: 'failed'; message: string }
    | { status: 'ready'; catalog: SkillCatalog };

/**
 * The skills the daemon lists for the open project (or none), kept current: it loads again when the daemon
 * announces `skills.changed`, and after every switch. `toggle` switches a user skill and reports a refusal.
 */
export function useSkills(projectId: ProjectId | undefined) {
    const root = useRootStore();
    const [state, setState] = useState<SkillsState>({ status: 'loading' });
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [attempt, setAttempt] = useState(0);
    const { skillsRevision } = root;

    useEffect(() => {
        let current = true;

        root.transport.getSkills(projectId).then(
            catalog => current && setState({ status: 'ready', catalog }),
            error =>
                current &&
                setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
        );

        return () => {
            current = false;
        };
    }, [root, projectId, skillsRevision, attempt]);

    const reload = useCallback(() => setAttempt(count => count + 1), []);

    const toggle = useCallback(
        async (skill: SkillEntry, enabled: boolean) => {
            setPending(names => new Set(names).add(skill.name));

            const result = await root.command({ type: 'skills.setEnabled', name: skill.name, enabled });

            if (!result.ok) toast.error({ message: result.error.message });

            setPending(names => {
                const rest = new Set(names);

                rest.delete(skill.name);

                return rest;
            });
            reload();
        },
        [root, reload]
    );

    return { state, pending, reload, toggle };
}
