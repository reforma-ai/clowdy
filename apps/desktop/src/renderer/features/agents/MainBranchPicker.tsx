import { Text } from '@clowdy/components/Text';
import { useMemo } from 'react';

import { homeFolder } from '../../shared/homeFolder';
import { BranchPickerWithCreate } from './BranchPickerWithCreate';
import styles from './MainBranchPicker.module.css';
import { currentBranchOf, type MainBranchBlock, mainBranchOptions } from './mainBranch';

import type { GitHead } from '@clowdy/protocol';
import type { BranchSwitch } from '../changes/BranchSwitch';
import type { BranchListing } from '../changes/branchChoices';

export interface MainBranchPickerProps {
    model?: BranchSwitch;
    head?: GitHead;
    /** The row of the menu the list opens beside. */
    anchor: Element;
    /** The folder's branches, once read. */
    listing: BranchListing | undefined;
    /** The read is on its way. */
    loading: boolean;
    /** Why the read failed, when it did. */
    listFailure: string | undefined;
    /** The branch the person chose, when they did: the check goes to it, else to the branch the folder is on. */
    chosen: string | undefined;
    /** What the window knows that is in the way of a switch (`mainBranchBlock`): every branch but the folder's own is off. */
    block: MainBranchBlock | undefined;
    /** What the daemon answered when the chat was sent and it would not switch: the reason stays here for as long as the choice does. */
    refusal: MainBranchBlock | undefined;
    onPick: (branch: string) => void;
    onClose: () => void;
}

/**
 * The list of the new chat's branch uses the same grouping as the Changes branch picker. The folder's own branch is checked unless the person chose another.
 * Picking a branch records a choice for the daemon to apply when the chat starts. While something is in the way, every other branch goes under Unavailable and the reason is under the list;
 * after a refusal at send the daemon's reason is there, and stays until the choice changes.
 */
export function MainBranchPicker({
    model,
    head,
    anchor,
    listing,
    loading,
    listFailure,
    chosen,
    block,
    refusal,
    onPick,
    onClose,
}: MainBranchPickerProps) {
    const options = useMemo(
        () => (listing ? mainBranchOptions(listing, block, homeFolder.path) : []),
        [listing, block]
    );
    const current = listing ? currentBranchOf(listing) : undefined;
    const selected = chosen ?? current;
    const why = refusal ?? block;

    return (
        <BranchPickerWithCreate
            model={model}
            head={head}
            anchor={anchor}
            placement="right top"
            options={options}
            selectedIds={selected === undefined ? [] : [selected]}
            aria-label="Branches of the folder"
            placeholder="Filter branches"
            empty={loading ? 'Loading branches' : 'No branches to show'}
            footer={
                (why || listFailure) && (
                    <div className={styles.reason} role={refusal || listFailure ? 'alert' : 'status'}>
                        {why && (
                            <>
                                <Text variant="xs" color={refusal ? 'danger' : 'default'} select="text">
                                    {why.message}
                                </Text>
                                {why.hint && (
                                    <Text variant="xs" color="secondary" select="text">
                                        {why.hint}
                                    </Text>
                                )}
                            </>
                        )}
                        {listFailure && (
                            <Text variant="xs" color="danger" select="text">
                                {listFailure}
                            </Text>
                        )}
                    </div>
                )
            }
            onPick={onPick}
            onClose={onClose}
        />
    );
}
