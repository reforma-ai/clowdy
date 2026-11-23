import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { isBusyRunStatus } from '@clowdy/protocol';
import { useEffect, useRef, type RefObject } from 'react';

import { StatusDot } from '../../shared/StatusDot';
import { useProjectState } from '../../stores';
import { chatFolder } from '../agents/agentTree';
import {
    accessHint,
    accessHintTitle,
    additionsWords,
    CHECK_STATE_VIEW,
    checksTone,
    checksWords,
    deletionsWords,
    hasBranchFiles,
    PULL_REQUEST_STATE_LABEL,
    sortedChecks,
} from '../changes/gitSummary';
import { useGitFacts, useGitFactsStore } from '../changes/useGitFacts';
import { openEffects } from '../openWith';
import { chatPlace } from '../sidePanel/currentPlace';
import { ComposerBanner } from './ComposerBanner';
import styles from './GitStrip.module.css';

import type { Chat, GitPullRequest, Run } from '@clowdy/protocol';
import type { PlaceFacts } from '../changes/gitFacts';

/**
 * The checks of a pull request as a list that opens from the dot, above the whole chip (`anchor`), so it starts where the chip does: each with the colour of its state, its name and its
 * state in words; a press opens the check's own page, when it has one. Read only.
 */
function ChecksMenu({ pr, anchor }: { pr: GitPullRequest; anchor: RefObject<HTMLElement | null> }) {
    const { checks } = pr;
    const items = sortedChecks(checks.items);
    const words = checksWords(checks);

    return (
        <MenuTrigger>
            <Button size="xs" variant="ghost" color="secondary" iconOnly className={ styles.checks } aria-label={ `Checks: ${ words }` } tooltip={ words }>
                <StatusDot tone={ checksTone(checks) } />
            </Button>
            <Popover triggerRef={ anchor } placement="top start" spacing="xs" width={ 320 }>
                <PopoverScroll maxHeight={ 320 }>
                    <Menu
                        aria-label="Checks"
                        size="sm"
                        onAction={ (key) => {
                            const { url } = items[Number(key)] ?? {};

                            if (url) openEffects.openUrl(url);
                        } }
                    >
                        { items.map((check, index) => {
                            const view = CHECK_STATE_VIEW[check.state];

                            return (
                                <MenuItem
                                    // The names are one for each check, but a status and a check run may share one.
                                    key={ `${ index }:${ check.name }` }
                                    id={ String(index) }
                                    textValue={ check.name }
                                    isDisabled={ !check.url }
                                    icon={ <StatusDot tone={ view.tone } /> }
                                    endAffix={ <Text variant="xs" color="secondary">{ view.label }</Text> }
                                >
                                    { check.name }
                                </MenuItem>
                            );
                        }) }
                    </Menu>
                </PopoverScroll>
            </Popover>
        </MenuTrigger>
    );
}

/**
 * The pull request of the branch as a chip in two parts: its number and state, whose press opens the pull request on GitHub, and, when it has checks, a dot of what they add
 * up to, which opens their list. An open one has its state in the success colour; draft, merged and closed ones stay in the neutral tone, since the colours are for what needs
 * a look.
 */
function PullRequestChip({ pr, stale }: { pr: GitPullRequest; stale: boolean }) {
    const state = PULL_REQUEST_STATE_LABEL[pr.state];
    const hasChecks = checksTone(pr.checks) !== undefined;
    const chip = useRef<HTMLDivElement>(null);

    return (
        <div ref={ chip } role="group" aria-label="Pull request" className={ styles.chip } data-stale={ stale || undefined }>
            <Button
                size="xs"
                variant="ghost"
                color="secondary"
                className={ styles.pr }
                aria-label={ `Open pull request ${ pr.number } on GitHub: ${ state }, ${ pr.title }` }
                tooltip={ pr.title }
                onPress={ () => openEffects.openUrl(pr.url) }
            >
                <Text variant="xs" weight="medium">{ `PR #${ pr.number }` }</Text>
                <Text variant="xs" color={ pr.state === 'open' ? 'success' : 'secondary' }>{ state }</Text>
            </Button>
            { hasChecks && <ChecksMenu pr={ pr } anchor={ chip } /> }
        </div>
    );
}

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

/** What the strip draws, from what is known of the place; nothing when there is nothing to say. */
function StripRow({ facts }: { facts: PlaceFacts }) {
    const { pr, dirty, branch } = facts;
    const hint = pr ? undefined : accessHint(facts.access, facts.repo);
    const files = hasBranchFiles(branch) ? branch : undefined;

    if (!pr && !hint && !files && !dirty) return null;

    return (
        <ComposerBanner role="group" aria-label="Pull request and changes">
            <div className={ styles.row }>
                <div className={ styles.start }>
                    { pr && <PullRequestChip pr={ pr } stale={ facts.pullRequest.stale } /> }
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

    return <StripRow facts={ facts } />;
}
