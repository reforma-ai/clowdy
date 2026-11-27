import { gitRead } from '../domain/git';

/** A ref's commit, null when both names are absent, undefined when Git could not verify them. */
export async function readWorktreeBase(folder: string, name: string): Promise<string | null | undefined> {
    const local = `refs/heads/${name}`;
    const remote = `refs/remotes/${name}`;
    // for-each-ref succeeds with empty output for absent refs, but also skips broken refs with a warning.
    // Only a read without warnings can establish absence.
    const result = await gitRead(folder, ['for-each-ref', '--format=%(refname)%00%(objectname)', local, remote], {
        rejectStderr: true,
    });
    if (!result.ok) return undefined;
    const found = new Map<string, string>();
    for (const line of result.stdout.split('\n')) {
        if (!line) continue;
        const separator = line.indexOf('\0');
        if (separator < 0) return undefined;
        const ref = line.slice(0, separator);
        if (ref !== local && ref !== remote) continue;
        const commit = line.slice(separator + 1);
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) || found.has(ref)) return undefined;
        found.set(ref, commit);
    }
    return found.get(local) ?? found.get(remote) ?? null;
}

/** Keep an existing recorded base; only a definitively absent one may fall back to the folder's current base. */
export async function resolveWorktreeBase(
    recorded: string | undefined,
    readFallback: () => string | undefined | Promise<string | undefined>,
    read: (name: string) => Promise<string | null | undefined>
): Promise<{ name: string; commit: string } | undefined> {
    if (recorded !== undefined) {
        const commit = await read(recorded);
        if (commit === undefined) return undefined;
        if (commit !== null) return { name: recorded, commit };
    }
    const fallback = await readFallback();
    if (fallback === undefined || fallback === recorded) return undefined;
    const commit = await read(fallback);
    return commit ? { name: fallback, commit } : undefined;
}
