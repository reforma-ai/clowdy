import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { isBusyRunStatus } from '@clowdy/protocol';
import { useEffect, useRef } from 'react';

import { StatusDot } from '../../shared/StatusDot';
import { useProjectState } from '../../stores';
import { chatFolder } from '../agents/agentTree';
import { createPullRequest, isOffered } from '../changes/changesActions';
import { CreatePullRequest } from '../changes/CreatePullRequest';
import { accessHint, accessHintTitle, additionsWords, deletionsWords, hasBranchFiles } from '../changes/gitSummary';
import { PullRequestChip } from '../changes/PullRequestChip';
import { useGitFacts, useGitFactsStore } from '../changes/useGitFacts';
import { useFolderGit } from '../openWith';
import { chatPlace } from '../sidePanel/currentPlace';
import { ComposerBanner } from './ComposerBanner';
import styles from './GitStrip.module.css';

import type { Chat, ProjectId, Run } from '@clowdy/protocol';
import type { PlaceFacts } from '../changes/gitFacts';
import type { Place } from '../sidePanel/currentPlace';

/** What the strip says of the files of the branch: `Files changed 13 +104 −38`. */
function FilesChanged({ files, additions, deletions, complete }: { files: number; additions: string; deletions: string; complete: boolean }) {
    return (
        <span role="group" aria-label={ `Files changed: ${ files }, ${ additions }, ${ deletions }` } className={ styles.files } title={ complete ? undefined : 'Some files weren\'t counted' }>
            <Text variant="xs" color="secondary" className={ styles.filesLabel }>Files changed</Text>
            <Text variant="xs" weight="medium">{ files }</Text>
            <Text variant="xs" color="success">{ additions }</Text>
            <Text variant="xs" color="danger">{ deletions }</Text>
        </span>
    );
}

/** Create PR as the strip offers it: the sidebar's button in its quiet form, which reads what git says of the folder for the address of the page. */
function StripCreatePullRequest({ facts, projectId, place }: { facts: PlaceFacts; projectId: ProjectId; place: Place }) {
    const git = useFolderGit(projectId, place.folder.id, place.workspace);

    return <CreatePullRequest facts={ facts } git={ git } quiet />;
}

/** What the strip draws, from what is known of the place; nothing when there is nothing to say. */
function StripRow({ facts, projectId, place }: { facts: PlaceFacts; projectId: ProjectId; place: Place }) {
    const { pr, dirty, branch } = facts;
    const hint = pr ? undefined : accessHint(facts.access, facts.repo);
    const files = hasBranchFiles(branch) ? branch : undefined;
    // Where the branch has no pull request, work ahead of its base and is not the base itself, Create PR is a quiet offer here, by the one rule the sidebar's button has (it is read again from
    // the place's folder for the address of the page, so a remote that is not GitHub's makes it nothing).
    const creatable = !pr && facts.pullRequest.settled && isOffered(createPullRequest({ status: facts.status.value, hasPullRequest: false, onGitHub: facts.access !== 'no_remote' }));

    if (!pr && !hint && !files && !dirty && !creatable) return null;

    return (
        <ComposerBanner role="group" aria-label="Pull request and changes">
            <div className={ styles.row }>
                <div className={ styles.start }>
                    { pr && <PullRequestChip pr={ pr } stale={ facts.pullRequest.stale } /> }
                    { creatable && <StripCreatePullRequest facts={ facts } projectId={ projectId } place={ place } /> }
                    { hint && <Text variant="xs" color="secondary" truncate className={ styles.hint } title={ accessHintTitle(facts.access, facts.repo) }>{ hint }</Text> }
                </div>
                <div className={ styles.end }>
                    { files && <FilesChanged files={ files.files } additions={ additionsWords(files) } deletions={ deletionsWords(files) } complete={ files.complete } /> }
                    { dirty && (
                        <Tooltip content="Uncommitted changes" placement="top">
                            <span className={ styles.dirty } role="img" aria-label="Uncommitted changes" tabIndex={ 0 }>
                                <StatusDot tone="warning" />
                            </span>
                        </Tooltip>
                    ) }
                </div>
            </div>
        </ComposerBanner>
    );
}

/**
 * The line above the message box that says how the chat's work stands in git: the pull request of the branch (number, state, its checks) and the size of the branch against its base
 * (`Files changed 13 +104 −38`), with a dot when the tree has uncommitted files. It reads the facts of the place the chat works in (`useGitFacts`, shared with the Info tab), for a
 * read-only chat too, as the folder line is. Nothing at all for a folder that is no repository, for a worktree that is not made yet, and until the first answer has come, so the
 * strip never flashes in and out while it loads; it is one row, so it moves the message box by that much when it comes. When the chat's run ends (it is no longer busy) the facts are read
 * again, since the agent has most likely changed files, committed or pushed.
 */
export function GitStrip({ chat, run }: { chat: Chat; run: Run | undefined }) {
    const project = useProjectState();
    const { folders } = project.project;
    const place = chatPlace(folders, chat, chatFolder(project.chats, folders, chat.id)?.folder);
    const facts = useGitFacts(project.id, place);
    const store = useGitFactsStore();
    const busy = run !== undefined && isBusyRunStatus(run.status);
    const wasBusy = useRef(busy);

    useEffect(() => {
        if (wasBusy.current && !busy && facts) store.refresh(facts.key);

        wasBusy.current = busy;
    }, [busy, facts, store]);

    if (!facts?.ready || facts.isRepository !== true) return null;

    return <StripRow facts={ facts } projectId={ project.id } place={ place } />;
}
