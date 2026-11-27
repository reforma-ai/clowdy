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
    /** The current status of the dot and its accessible description. */
    dot?: { tone: 'primary' | 'neutral' | 'success'; label: string };
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

    const visible = partitionPullRequests(rows).visible;
    const pullRequest = visible.length > 0;
    const open = visible.find(pr => pr.state === 'open' || pr.state === 'draft');
    const ahead = status?.isRepository === true && status.base.state === 'ready' ? status.base.ahead : 0;
    const dot = summary.uncommittedLine
        ? { tone: 'primary' as const, label: summary.uncommittedLine }
        : open
          ? {
                tone: 'success' as const,
                label: `${open.state === 'draft' ? 'Draft pull request' : 'Open pull request'} #${open.number}`,
            }
          : ahead > 0 || summary.syncLine || summary.stage === 'problem'
            ? {
                  tone: 'neutral' as const,
                  label:
                      (summary.stage === 'problem' || summary.stage === 'ahead' ? summary.stageLine : undefined) ??
                      summary.syncLine ??
                      `${commitsWords(ahead)} not merged`,
              }
            : undefined;

    return { ...summary, pullRequest, dot };
}
