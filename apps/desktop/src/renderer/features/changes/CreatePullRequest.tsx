import { Button } from '@clowdy/components/Button';
import { Github } from '@clowdy/icons/logo';

import { openEffects } from '../openWith';
import { compareLink } from '../openWith/openTarget';
import styles from './CreatePullRequest.module.css';
import { branchOf, type CreatePullRequestState, createPullRequest, githubBaseName } from './changesActions';
import { useRemoteActions } from './useRemoteActions';

import type { FolderGit } from '../openWith/openTarget';
import type { PlaceFacts } from './gitFacts';

/** What Create PR is for a place, and the compare page it opens: both from the place's git facts and what git says of the folder. Nothing until the pull request has been read once. */
export function createPullRequestOf(
    facts: PlaceFacts,
    git: FolderGit | undefined
): { state: CreatePullRequestState | undefined; link: string | undefined } {
    const status = facts.status.value;
    const repository = status?.isRepository === true ? status : undefined;
    // The page is about the branch as GitHub has it, which is the branch's own name: it is offered once the branch is published under it.
    const branch = repository && branchOf(repository);
    // A host of GitHub Enterprise is GitHub's when the person's `gh` is signed in to it, which is all the app can tell of it.
    const enterprise = facts.access === 'ready' ? facts.repo?.host : undefined;
    const link =
        repository && branch !== undefined
            ? compareLink(git, { head: branch, base: githubBaseName(repository.base) }, enterprise)
            : undefined;

    // A pull request that has not been read yet may be there: nothing is offered in its place until it has. A remote that the daemon found to name no repository has no page either.
    return {
        link,
        state: facts.pullRequest.settled
            ? createPullRequest({
                  status,
                  hasPullRequest: facts.pr !== undefined,
                  onGitHub: link !== undefined && facts.access !== 'no_remote',
              })
            : undefined,
    };
}

/** What a press on the button does and says, by the state. */
const TOOLTIPS: Record<Exclude<CreatePullRequestState['kind'], 'blocked'>, string> = {
    ready: 'Open the pull request page on GitHub',
    publish: 'Publish the branch to origin first',
    push: 'Push the new commits to origin first',
};

export interface CreatePullRequestProps {
    facts: PlaceFacts;
    /** What git says of the place's folder (its `origin`), which the compare page is built from. */
    git: FolderGit | undefined;
}

/**
 * Create PR, where the branch has no pull request: it opens GitHub's compare page for the branch against the base the Changes tab compares with, in the browser (`openUrl`, as GitHub
 * Desktop does; there is no `gh pr create`). A branch that is not on origin says `Publish first` and a branch with commits that are not says `Push first`: a press does that, and the button then
 * becomes `Create PR`, so the page is never opened for a branch GitHub does not have. On the branch the work is compared with it is off, with `Switch to a feature branch`. Once the branch has
 * a pull request this is not drawn: the chip is its link.
 */
export function CreatePullRequest({ facts, git }: CreatePullRequestProps) {
    const remote = useRemoteActions(facts);
    const { state, link } = createPullRequestOf(facts, git);

    if (!state) return null;

    const press = () => {
        if (state.kind === 'ready' && link) openEffects.openUrl(link);
        else if (state.kind === 'publish') void remote.run('publish');
        else if (state.kind === 'push') void remote.run('push');
    };
    const working =
        state.kind !== 'ready' &&
        state.kind !== 'blocked' &&
        remote.running === (state.kind === 'publish' ? 'publish' : 'push');

    return (
        <Button
            variant="bordered"
            color="secondary"
            size="sm"
            className={styles.button}
            isDisabled={state.kind === 'blocked' || (remote.busy && !working)}
            isPending={working}
            spinnerPlacement="start"
            tooltip={state.kind === 'blocked' ? state.reason : TOOLTIPS[state.kind]}
            tooltipPlacement="bottom"
            onPress={press}
        >
            {/* The spinner stands where the mark does while the press is at work. */}
            {!working && <Github size={14} aria-hidden="true" />}
            {state.label}
        </Button>
    );
}
