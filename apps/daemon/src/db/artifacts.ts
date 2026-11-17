import { parseJson } from './json';

import type { Artifact } from '@clowdy/protocol';
import type { Database } from 'bun:sqlite';

interface ArtifactRow {
    id: string;
    project_id: string;
    run_id: string | null;
    task_id: string | null;
    kind: Artifact['kind'];
    title: string;
    ref: string;
    created_at: number;
}

export function listArtifactsOfTask(db: Database, taskId: string): Artifact[] {
    return (db.query('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at, id').all(taskId) as ArtifactRow[]).map(row => ({
        id: row.id,
        projectId: row.project_id,
        ...(row.run_id && { runId: row.run_id }),
        ...(row.task_id && { taskId: row.task_id }),
        kind: row.kind,
        title: row.title,
        ref: parseJson<Record<string, unknown>>(row.ref) ?? {},
        createdAt: row.created_at,
    }));
}
