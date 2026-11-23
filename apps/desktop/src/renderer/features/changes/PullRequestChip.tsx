import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { useRef, type RefObject } from 'react';

import { StatusDot } from '../../shared/StatusDot';
import { openEffects } from '../openWith';
import { CHECK_STATE_VIEW, checksTone, checksWords, PULL_REQUEST_STATE_LABEL, sortedChecks } from './gitSummary';
import styles from './PullRequestChip.module.css';

import type { GitPullRequest } from '@clowdy/protocol';

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
export function PullRequestChip({ pr, stale }: { pr: GitPullRequest; stale: boolean }) {
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
