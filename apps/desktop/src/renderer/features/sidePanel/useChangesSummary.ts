import { useRootStore } from '../../stores';
import { pullRequestRows } from '../changes/BranchPullRequestList';
import { partitionPullRequests, useBranchPullRequests } from '../changes/branchPullRequests';
import { commitsWords } from '../changes/changesActions';
import { type ChangesSummary, changesSummary } from '../changes/changesStage';
import { useGitFacts } from '../changes/useGitFacts';
import { currentPlace } from './currentPlace';

/** What the rail says of the changes of a place: `changesSummary`, whether the branch has a pull request to show, and whether it has work that is nowhere else. */
export interface RailChanges extends ChangesSummary {
    /** A pull request is shown under the sync button of Source Control (an open or draft one, or the newest merged one the branch has not moved past): the tab draws the merge icon. */
    pullRequest: boolean;
    /**
     * The branch has work that exists nowhere else: files that are uncommitted, or commits that are not merged and are in no pull request (not an open or draft one, and not a merged one
     * that the branch has not moved past). The tab draws a dot for it while it is not the one on show.
     */
    unlanded: boolean;
    /** What the dot stands for, for a screen reader: `3 uncommitted files, 2 commits not merged`. */
    unlandedLabel: string;
}

/**
 * What the rail says of the changes of the place the window works in (the one the Changes tab shows), whether that tab is on show or not. It reads the place's git facts and the
 * pull requests of its branch, as the tab does (the stores count the readers, so they are one). Nothing while no project's screen is on show, the place is a worktree not made
 * yet, or it is no repository.
 */
export function useChangesSummary(): RailChanges | undefined {
    const root = useRootStore();
    const project = root.projectScreenReady ? root.selectedProject : undefined;
    const ui = project ? root.ui.forProject(project.id) : undefined;
    const place = project && ui ? currentPlace(project, ui) : undefined;
    const facts = useGitFacts(project?.id, place);
    const status = facts?.status.value;
    const branch = status?.isRepository === true && status.head.kind === 'branch' ? status.head.name : undefined;
    const history = useBranchPullRequests(
        project && place && branch ? { projectId: project.id, folderId: place.folder.id, branch } : undefined
    );

    if (!facts) return undefined;

    const summary = changesSummary(status, facts.pr);

    if (!summary) return undefined;

    // The rows that Source Control draws under the sync button, from the same history and the same current pull request.
    const current = branch !== undefined && facts.pr?.head === branch ? facts.pr : undefined;
    const rows = pullRequestRows(
        history?.pullRequests ?? [],
        history?.stale ?? false,
        current,
        facts.pullRequest.stale
    );

    const pullRequest = partitionPullRequests(rows).visible.length > 0;
    const ahead = status?.isRepository === true && status.base.state === 'ready' ? status.base.ahead : 0;
    const unmerged = ahead > 0 && !pullRequest ? `${commitsWords(ahead)} not merged` : undefined;
    const reasons = [summary.uncommittedLine, unmerged].filter(reason => reason !== undefined);

    return { ...summary, pullRequest, unlanded: reasons.length > 0, unlandedLabel: reasons.join(', ') };
}
