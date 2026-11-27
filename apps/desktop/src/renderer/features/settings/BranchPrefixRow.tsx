import { Input } from '@clowdy/components/Input';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { Text } from '@clowdy/components/Text';
import { branchPrefixProblem, DEFAULT_BRANCH_PREFIX } from '@clowdy/protocol';
import { useState } from 'react';

import { branchPrefix } from '../chats/branchPrefix';

/**
 * The branch prefix of a new worktree (Settings > Source Control). A prefix the daemon would take is kept as it is typed; one it would refuse stays in the box with the
 * reason under it, and the last good one stays in force until it is fixed, so a chat never meets a refusal from here. An empty box is the default again.
 */
export function BranchPrefixRow() {
    // Saved as it is typed, so the draft is not dropped when the value changes, only when the box is left with a prefix the daemon takes.
    const [draft, setDraft] = useState<string>();
    const problem = draft === undefined ? undefined : branchPrefixProblem(draft);

    return (
        <SettingsLayout.Row
            title="Branch prefix"
            description={`Branches of new worktrees are named like ${branchPrefix.value}/ab12cd34`}
            controlWidth="14rem"
            footer={
                problem && (
                    <Text variant="sm" color="danger" role="alert">
                        {problem}
                    </Text>
                )
            }
        >
            <Input
                type="text"
                variant="bordered"
                size="sm"
                placeholder={DEFAULT_BRANCH_PREFIX}
                isInvalid={problem !== undefined}
                value={draft ?? branchPrefix.value}
                onChange={text => {
                    setDraft(text);
                    branchPrefix.setValue(text);
                }}
                onBlur={() => {
                    if (!problem) setDraft(undefined);
                }}
                onKeyDown={event => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                }}
            />
        </SettingsLayout.Row>
    );
}
