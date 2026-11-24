import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Commit, Folder, Page, Version } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';

import { PathText } from '../../shared/PathText';
import { ProjectIcon } from '../../shared/ProjectIcon';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import {
    additionsWords,
    aheadBehindWords,
    deletionsWords,
    filesWords,
    hasBranchFiles,
    PULL_REQUEST_STATE_LABEL,
} from '../changes/gitSummary';
import { useGitFacts } from '../changes/useGitFacts';
import { openEffects, useFolderGit } from '../openWith';
import { openManageWorktrees } from '../worktrees';
import { currentPlace } from './currentPlace';
import styles from './InfoTab.module.css';

import type { ReactNode } from 'react';

function InfoRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
    return (
        <div className={styles.row}>
            <dt className={styles.label}>
                <span className={styles.icon}>{icon}</span>
                <Text color="secondary">{label}</Text>
            </dt>
            <dd className={styles.value}>{children}</dd>
        </div>
    );
}

/**
 * The panel's Info tab: what the window is working on, as a short list: the project, its folder, the worktree of the open chat when it works in one, and the branch that is
 * checked out in the place (the worktree's own, which an agent may have switched). The Worktree row has a Manage button, which opens the dialog of the project's worktrees on
 * the folder; a chat in the folder's own checkout has no such row, and the Files tab's bar is its way in. After the branch come the rows of the place's git facts (`useGitFacts`,
 * the Changes tab reads the same ones): the base the branch is compared with, how far it is from it, its pull request (a press opens it on GitHub) and the size
 * of its work. A row shows only what is known: none of them while the place is no repository, a worktree that is not made yet, or before the first answer.
 */
export function InfoTab() {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const place = currentPlace(project, ui);
    const { folder, workspace } = place;
    const git = useFolderGit(project.id, folder.id, workspace);
    const facts = useGitFacts(project.id, place);
    const base = facts?.base?.state === 'ready' ? facts.base : undefined;
    const aheadBehind = aheadBehindWords(base);
    const pr = facts?.pr;
    const files = hasBranchFiles(facts?.branch) ? facts.branch : undefined;

    return (
        <dl className={styles.info}>
            <InfoRow icon={<ProjectIcon project={project.project} />} label="Project">
                <Text truncate>{project.project.name}</Text>
            </InfoRow>
            <InfoRow icon={<Folder aria-hidden="true" />} label="Folder">
                <PathText path={folder.path} />
            </InfoRow>
            {workspace && (
                <InfoRow icon={<Folder aria-hidden="true" />} label="Worktree">
                    <PathText path={workspace.path} />
                    <Button
                        variant="filling"
                        color="secondary"
                        size="xs"
                        className={styles.manage}
                        tooltip="Folder settings"
                        aria-label="Folder settings"
                        onPress={() => openManageWorktrees({ root, projectId: project.id, folderId: folder.id })}
                    >
                        Manage
                    </Button>
                </InfoRow>
            )}
            {git?.branch && (
                <InfoRow icon={<Version aria-hidden="true" />} label="Branch">
                    <Text truncate title={git.detached ? 'Detached HEAD' : undefined}>
                        {git.branch}
                    </Text>
                </InfoRow>
            )}
            {base && (
                <InfoRow icon={<Version aria-hidden="true" />} label="Base">
                    <Text truncate>{base.name}</Text>
                </InfoRow>
            )}
            {aheadBehind && (
                <InfoRow icon={<Commit aria-hidden="true" />} label="Ahead and behind">
                    <Text truncate>{aheadBehind}</Text>
                </InfoRow>
            )}
            {pr && (
                <InfoRow icon={<Github size={14} />} label="Pull request">
                    <Button
                        variant="inline"
                        truncate
                        tooltip={pr.title}
                        aria-label={`Open pull request ${pr.number} on GitHub`}
                        onPress={() => openEffects.openUrl(pr.url)}
                    >
                        {`#${pr.number} ${PULL_REQUEST_STATE_LABEL[pr.state]}`}
                    </Button>
                </InfoRow>
            )}
            {files && (
                <InfoRow icon={<Page aria-hidden="true" />} label="Files changed">
                    <Text truncate>
                        {`${filesWords(files.files)}, `}
                        <Text color="success">{additionsWords(files)}</Text>{' '}
                        <Text color="danger">{deletionsWords(files)}</Text>
                    </Text>
                </InfoRow>
            )}
        </dl>
    );
}
