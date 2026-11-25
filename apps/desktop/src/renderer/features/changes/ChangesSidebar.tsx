import { CopyButton } from '@clowdy/components/CopyButton';
import { Panel, PanelHeader } from '@clowdy/components/Panel';
import { Text } from '@clowdy/components/Text';
import { Version } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';
import { useEffect, useRef } from 'react';

import { useRootStore } from '../../stores';
import { openEffects, useFolderGit } from '../openWith';
import { githubLink } from '../openWith/openTarget';
import { BranchPicker } from './BranchPicker';
import { BranchPullRequestList, pullRequestRows } from './BranchPullRequestList';
import { branchPullRequestsOf, useBranchPullRequests } from './branchPullRequests';
import styles from './ChangesSidebar.module.css';
import viewStyles from './ChangesView.module.css';
import { CommitBox } from './CommitBox';
import { CreatePullRequest } from './CreatePullRequest';
import { accessHint, accessHintTitle } from './gitSummary';
import { RemoteMenu } from './RemoteMenu';

import type { GitStatus } from '@clowdy/protocol';
import type { ReactNode } from 'react';
import type { Place } from '../sidePanel/currentPlace';
import type { PlaceChanges } from './PlaceChanges';

/** How the checked-out head is named: the branch, or the commit a detached head is at. Nothing until the status has been read, and for a folder that is no repository. */
export function headName(status: GitStatus | undefined): string | undefined {
    if (status?.isRepository !== true) return undefined;

    const { head } = status;

    return head.kind === 'detached' ? `Detached at ${head.commit.slice(0, 7)}` : head.name;
}

/**
 * The sidebar of the tab, at the right of the diffs: the checked-out branch, sync and comparison actions, the pull request, and the commit box. The facts at the top open the menu
 * of Fetch, Pull and Push or Publish (`RemoteMenu`), and the pull request as the shared chip, or, while there is none, Create PR (`CreatePullRequest`), which opens GitHub's compare page
 * once the branch is on origin. `toggle` is the button that hides the sidebar, at the end of its header.
 */
export function ChangesSidebar({
    model,
    place,
    projectId,
    toggle,
}: {
    model: PlaceChanges;
    place: Place;
    projectId: string;
    toggle: ReactNode;
}) {
    const { facts } = model;
    const git = useFolderGit(projectId, place.folder.id, place.workspace);
    const histories = branchPullRequestsOf(useRootStore().transport);
    const status = facts.status.value;
    const currentBranch =
        !git?.gone && status?.isRepository === true && status.head.kind === 'branch' ? status.head.name : undefined;
    const historyBranch =
        currentBranch ??
        (git?.gone && place.workspace ? histories.workspaceHistoryBranch(projectId, place.workspace, git) : undefined);
    const branch = git?.gone ? historyBranch : headName(status);
    const branchName = git?.gone
        ? historyBranch
        : status?.isRepository === true && status.head.kind !== 'detached'
          ? status.head.name
          : undefined;
    const canPickBranch =
        !git?.gone && branch !== undefined && status?.isRepository === true && status.head.kind !== 'unborn';
    const workspaceId = place.workspace?.id;
    useEffect(() => {
        if (workspaceId && git && !git.gone) {
            histories.rememberWorkspaceBranch(projectId, workspaceId, git.detached ? null : (git.branch ?? null));
        }
    }, [histories, projectId, workspaceId, git]);
    const history = useBranchPullRequests(
        historyBranch ? { projectId, folderId: place.folder.id, branch: historyBranch } : undefined
    );
    const pr = currentBranch && facts.pr?.head === currentBranch ? facts.pr : undefined;
    const repo = facts.repo;
    const prStale = facts.pullRequest.stale;
    // The open PR can be discovered before the separately cached history catches up.
    useEffect(() => {
        if (history && repo && pr && !prStale) history.noteCurrent(repo, pr);
    }, [history, repo, pr, prStale]);
    const rows = pullRequestRows(history?.pullRequests ?? [], history?.stale ?? false, pr, facts.pullRequest.stale);
    const hasOpen = rows.some(row => row.state === 'open' || row.state === 'draft');
    const hint = rows.length > 0 ? undefined : accessHint(facts.access, facts.repo);
    const repositoryLink = githubLink(git, { relative: '', kind: 'directory' });

    const priorRead = useRef({ history, generation: facts.generation });
    // Git writes and run completion refresh these facts, including a PR created outside Clowdy.
    useEffect(() => {
        const before = priorRead.current;
        priorRead.current = { history, generation: facts.generation };
        if (history && before.history === history && before.generation !== facts.generation) void history.refresh(true);
    }, [history, facts.generation]);

    return (
        <Panel side="right" className={styles.sidebar} aria-label="Changes sidebar">
            <PanelHeader className={canPickBranch ? viewStyles.pickerHeader : undefined}>
                <div className={styles.branchControls}>
                    {canPickBranch ? (
                        <BranchPicker facts={facts} label={branch} />
                    ) : (
                        <span className={styles.branch}>
                            <Version aria-hidden="true" className={styles.branchIcon} />
                            <Text weight="medium" truncate title={branch}>
                                {branch ?? 'Changes'}
                            </Text>
                        </span>
                    )}
                    {branchName !== undefined && (
                        <CopyButton
                            value={branchName}
                            size="xs"
                            variant="filling"
                            color="secondary"
                            aria-label="Copy branch name"
                            tooltip="Copy branch name"
                            tooltipPlacement="bottom"
                        />
                    )}
                </div>
                <PanelHeader.Actions>
                    {repositoryLink && (
                        <PanelHeader.Button
                            aria-label="Open the repository on GitHub"
                            tooltip="Open on GitHub"
                            tooltipPlacement="bottom"
                            onPress={() => openEffects.openUrl(repositoryLink)}
                        >
                            <Github size={14} />
                        </PanelHeader.Button>
                    )}
                    {toggle}
                </PanelHeader.Actions>
            </PanelHeader>

            <div className={styles.body}>
                {(rows.length > 0 || hint || status?.isRepository === true) && (
                    <div className={styles.facts}>
                        {!git?.gone && <RemoteMenu facts={facts} checkoutBranch={git?.checkoutBranch} />}
                        {!git?.gone && !pr && !hasOpen && <CreatePullRequest facts={facts} git={git} />}
                        <BranchPullRequestList key={historyBranch} rows={rows} />
                        {hint && (
                            <Text
                                variant="xs"
                                color="secondary"
                                truncate
                                title={accessHintTitle(facts.access, facts.repo)}
                            >
                                {hint}
                            </Text>
                        )}
                    </div>
                )}

                {!git?.gone && <CommitBox model={model} />}
            </div>
        </Panel>
    );
}
