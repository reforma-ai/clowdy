import type { Database } from 'bun:sqlite';
import type { GitHubRepo, GitPullRequestSummary } from '@clowdy/protocol';

/** GitHub repository names and owners are case insensitive, but branch names are not. */
export const repositoryKey = ({ host, owner, name }: GitHubRepo): string =>
    `${host.toLowerCase()}/${owner.toLowerCase()}/${name.toLowerCase()}`;

/** The last complete list that GitHub returned. Undefined means this branch has not been read successfully. */
export function readPullRequestHistory(
    db: Database,
    repository: string,
    branch: string
): GitPullRequestSummary[] | undefined {
    const row = db
        .query('SELECT data FROM git_pull_request_history WHERE repository = ? AND branch = ?')
        .get(repository, branch) as { data: string } | null;

    return row ? (JSON.parse(row.data) as GitPullRequestSummary[]) : undefined;
}

export const canArchivePullRequest = (pr: GitPullRequestSummary): boolean =>
    pr.state === 'merged' || pr.state === 'closed';

/** Saves a complete read and removes marks from any pull requests that have reopened. Run in one transaction. */
export function writePullRequestHistory(
    db: Database,
    repository: string,
    branch: string,
    pullRequests: GitPullRequestSummary[]
): void {
    db.query(`
        INSERT INTO git_pull_request_history (repository, branch, data) VALUES (?, ?, ?)
        ON CONFLICT(repository, branch) DO UPDATE SET data = excluded.data
    `).run(repository, branch, JSON.stringify(pullRequests));

    const reopened = pullRequests.filter(pr => !canArchivePullRequest(pr)).map(pr => pr.number);

    if (reopened.length > 0)
        db.query(
            'DELETE FROM git_pull_request_archives WHERE repository = ? AND number IN (SELECT value FROM json_each(?))'
        ).run(repository, JSON.stringify(reopened));
}

/** An archive never removes the history row. A restore removes only the local mark. */
export function setPullRequestArchive(db: Database, repository: string, number: number, archived: boolean): void {
    if (archived) {
        db.query('INSERT OR IGNORE INTO git_pull_request_archives (repository, number) VALUES (?, ?)').run(
            repository,
            number
        );
    } else {
        db.query('DELETE FROM git_pull_request_archives WHERE repository = ? AND number = ?').run(repository, number);
    }
}

/** Overlay the current marks even when the GitHub answer is still cached. */
export function withPullRequestArchives(
    db: Database,
    repository: string,
    pullRequests: GitPullRequestSummary[]
): GitPullRequestSummary[] {
    const archived = new Set(
        (
            db.query('SELECT number FROM git_pull_request_archives WHERE repository = ?').all(repository) as {
                number: number;
            }[]
        ).map(row => row.number)
    );

    return pullRequests.map(pr =>
        canArchivePullRequest(pr) && archived.has(pr.number) ? { ...pr, archived: true } : pr
    );
}
