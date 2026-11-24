import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Github } from '@clowdy/icons/logo';

import { openEffects } from '../openWith';
import { compareLink } from '../openWith/openTarget';
import { CommitCountBadge } from './CommitCountBadge';
import styles from './CreatePullRequest.module.css';
import { canCreatePullRequest, commitsWords, githubBaseName } from './changesActions';

import type { FolderGit } from '../openWith/openTarget';
import type { PlaceFacts } from './gitFacts';

/** Opens GitHub's compare page for a published branch that can be proposed and has no known pull request. */
export function CreatePullRequest({ facts, git }: { facts: PlaceFacts; git: FolderGit | undefined }) {
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

    const ahead = status.base.state === 'ready' ? status.base.ahead : 0;
    const comparison = ahead ? `${commitsWords(ahead)} ahead of the base` : undefined;
    const tooltip = 'Open the pull request page on GitHub';

    return (
        <Button
            variant="bordered"
            color="secondary"
            size="sm"
            className={styles.button}
            truncate
            isDisabled={facts.switching}
            aria-label="Create PR"
            aria-description={comparison}
            tooltip={comparison ? `${tooltip} · ${comparison}` : tooltip}
            tooltipPlacement="bottom"
            onPress={() => openEffects.openUrl(link)}
        >
            <Github size={14} aria-hidden="true" />
            <Text truncate>Create PR</Text>
            {ahead > 0 && <CommitCountBadge direction="up" count={ahead} />}
        </Button>
    );
}
