import { CopyButton } from '@clowdy/components/CopyButton';
import { Panel, PanelHeader } from '@clowdy/components/Panel';
import { Text } from '@clowdy/components/Text';
import { Version } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';

import { openEffects, useFolderGit } from '../openWith';
import { githubLink } from '../openWith/openTarget';
import { BranchPicker } from './BranchPicker';
import styles from './ChangesSidebar.module.css';
import viewStyles from './ChangesView.module.css';
import { CommitBox } from './CommitBox';
import { CreatePullRequest } from './CreatePullRequest';
import { accessHint, accessHintTitle } from './gitSummary';
import { PullRequestChip } from './PullRequestChip';
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
    const status = facts.status.value;
    const branch = headName(status);
    const branchName = status?.isRepository === true && status.head.kind !== 'detached' ? status.head.name : undefined;
    const canPickBranch = branch !== undefined && status?.isRepository === true && status.head.kind !== 'unborn';
    const { pr } = facts;
    const hint = pr ? undefined : accessHint(facts.access, facts.repo);
    const repositoryLink = githubLink(git, { relative: '', kind: 'directory' });
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
                {(pr || hint || status?.isRepository === true) && (
                    <div className={styles.facts}>
                        <RemoteMenu facts={facts} />
                        {pr ? (
                            <PullRequestChip pr={pr} stale={facts.pullRequest.stale} />
                        ) : (
                            <CreatePullRequest facts={facts} git={git} />
                        )}
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

                <CommitBox model={model} />
            </div>
        </Panel>
    );
}
