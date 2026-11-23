import { Input } from '@clowdy/components/Input';
import { Text } from '@clowdy/components/Text';
import { branchPrefixProblem, DEFAULT_BRANCH_PREFIX } from '@clowdy/protocol';
import { useState } from 'react';

import { branchPrefix } from '../chats/branchPrefix';
import styles from './BranchPrefixRow.module.css';
import { SettingsRow } from './ui/SettingsRow';

const LABEL = 'Branch prefix';

/**
 * The branch prefix of a new worktree (Settings > Chat). A prefix the daemon would take is kept as it is typed; one it would refuse stays in the box with the
 * reason under it, and the last good one stays in force until it is fixed, so a chat never meets a refusal from here. An empty box is the default again.
 */
export function BranchPrefixRow() {
    const [draft, setDraft] = useState<string>();
    const problem = draft === undefined ? undefined : branchPrefixProblem(draft);

    return (
        <SettingsRow
            title={ LABEL }
            description={ `Branches of new worktrees are named like ${ branchPrefix.value }/ab12cd34` }
            footer={ problem && <Text variant="sm" color="danger" role="alert">{ problem }</Text> }
        >
            <Input
                type="text"
                variant="bordered"
                size="sm"
                className={ styles.field }
                aria-label={ LABEL }
                placeholder={ DEFAULT_BRANCH_PREFIX }
                isInvalid={ problem !== undefined }
                value={ draft ?? branchPrefix.value }
                onChange={ (text) => {
                    setDraft(text);
                    branchPrefix.setValue(text);
                } }
                onBlur={ () => {
                    if (!problem) setDraft(undefined);
                } }
                onKeyDown={ (event) => {
                    if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                } }
            />
        </SettingsRow>
    );
}
