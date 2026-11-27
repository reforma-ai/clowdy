import { toast } from '@clowdy/components/Toast';
import { useCallback, useEffect, useState } from 'react';

import { useRootStore } from '../../../stores';

import type { Project, SkillCatalog } from '@clowdy/protocol';

export type SkillsState =
    | { status: 'loading' }
    | { status: 'failed'; message: string }
    | { status: 'ready'; catalog: SkillCatalog };

const loading: SkillsState = { status: 'loading' };

/** Fetch each scope independently so a failing project does not hide the other scopes. */
export function useSkills(projects: readonly Project[]) {
    const root = useRootStore();
    const [result, setResult] = useState<{ key: string; scopes: Record<string, SkillsState> }>({ key: '', scopes: {} });
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [attempt, setAttempt] = useState(0);
    // Folder changes affect the project catalog even when its ID stays the same.
    const projectKey = JSON.stringify(projects.map(project => [project.id, project.folders]));
    const key = JSON.stringify([projectKey, root.skillsRevision, attempt]);

    useEffect(() => {
        let current = true;
        const ids: string[] = JSON.parse(projectKey).map((project: [string]) => project[0]);
        setResult({ key, scopes: {} });
        for (const id of ['', ...ids]) {
            root.transport.getSkills(id || undefined).then(
                catalog => {
                    if (current)
                        setResult(previous => ({
                            ...previous,
                            scopes: { ...previous.scopes, [id]: { status: 'ready', catalog } },
                        }));
                },
                error => {
                    if (current)
                        setResult(previous => ({
                            ...previous,
                            scopes: {
                                ...previous.scopes,
                                [id]: {
                                    status: 'failed',
                                    message: error instanceof Error ? error.message : String(error),
                                },
                            },
                        }));
                }
            );
        }
        return () => {
            current = false;
        };
    }, [root, key, projectKey]);

    const reload = useCallback(() => setAttempt(count => count + 1), []);
    const toggle = useCallback(
        async (name: string, enabled: boolean) => {
            setPending(names => new Set(names).add(name));
            try {
                const result = await root.command({ type: 'skills.setEnabled', name, enabled });
                if (!result.ok) toast.error({ message: result.error.message });
            } catch (error) {
                toast.error({ message: error instanceof Error ? error.message : String(error) });
            } finally {
                setPending(names => {
                    const rest = new Set(names);
                    rest.delete(name);
                    return rest;
                });
                reload();
            }
        },
        [root, reload]
    );

    const scopes = result.key === key ? result.scopes : {};
    return { scope: (id: string) => scopes[id] ?? loading, pending, reload, toggle };
}
