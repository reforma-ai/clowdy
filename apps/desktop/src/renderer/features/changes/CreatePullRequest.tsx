import { Button } from '@clowdy/components/Button';
import { Github } from '@clowdy/icons/logo';

import { openEffects } from '../openWith';
import { compareLink } from '../openWith/openTarget';
import styles from './CreatePullRequest.module.css';
import { canCreatePullRequest, githubBaseName } from './changesActions';
import { useRemoteActions } from './useRemoteActions';

import type { FolderGit } from '../openWith/openTarget';
import type { PlaceFacts } from './gitFacts';

/** Opens GitHub's compare page for a published branch that can be proposed and has no known pull request. */
export function CreatePullRequest({ facts, git }: { facts: PlaceFacts; git: FolderGit | undefined }) {
    const remote = useRemoteActions(facts);
    const status = facts.status.value;

    if (
        status?.isRepository !== true ||
        status.head.kind !== 'branch' ||
        !facts.pullRequest.settled ||
        facts.access === 'no_remote' ||
        !canCreatePullRequest(status)
    ) {
        return null;
    }

    // An authenticated gh session identifies GitHub Enterprise hosts.
    const enterprise = facts.access === 'ready' ? facts.repo?.host : undefined;
    const link = compareLink(git, { head: status.head.name, base: githubBaseName(status.base) }, enterprise);

    if (!link) return null;

    return (
        <Button
            variant="bordered"
            color="secondary"
            size="sm"
            className={styles.button}
            isDisabled={remote.busy}
            tooltip="Open the pull request page on GitHub"
            tooltipPlacement="bottom"
            onPress={() => openEffects.openUrl(link)}
        >
            <Github size={14} aria-hidden="true" />
            Create PR
        </Button>
    );
}
