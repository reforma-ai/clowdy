import { Button } from '@clowdy/components/Button';
import { Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { ChevronDown } from '@clowdy/icons/8';
import { Version } from '@clowdy/icons/14';
import { useState } from 'react';

import { BranchList } from './BranchList';
import styles from './BranchPicker.module.css';
import { newBranchStarts } from './branchChoices';
import { NewBranchForm } from './NewBranchForm';
import { useBranchSwitch } from './useBranchSwitch';

import type { PlaceFacts } from './gitFacts';

export interface BranchPickerProps {
    facts: PlaceFacts;
    /** The branch the place is on as the sidebar names it: the branch, or `Detached at 1a2b3c4`. */
    label: string;
}

/**
 * The branch of the place as the title of the Changes sidebar and a button that changes it: a popover with `Current branch` as its title, a filter and the
 * groups `Default`, `Recent`, `Local` and `Remote`, a branch that another worktree has checked out dimmed with where, and `New branch…`, which opens the form of a new one in the same
 * popover. A press on a branch switches to it (`BranchSwitch`: the daemon refuses a tree with changes, a merge or rebase under way, a run working there and a branch held elsewhere, and
 * says why, and the reason is shown inside the popover, selectable); the popover shuts when the switch was made, never on a refusal. While a switch runs the button shows a spinner.
 * A chat worktree must also be merged into its base. The branches are read each time the popover opens.
 */
export function BranchPicker({ facts, label }: BranchPickerProps) {
    const model = useBranchSwitch(facts);
    const [isOpen, setIsOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const status = facts.status.value;
    const head = status?.isRepository === true ? status.head : undefined;
    const showCreate = (on: boolean) => {
        model.dismiss();
        setCreating(on);
    };
    const trigger = (
        <Button
            variant="transparent"
            color="secondary"
            size="sm"
            className={styles.trigger}
            contentClassName={styles.content}
            isPending={model.busy}
            spinnerPlacement="start"
            aria-label={`Current branch: ${label}`}
            // Constant while the popover is open or not: a button that gains or loses its tooltip is drawn in another place of the tree, and would lose the focus the popover gives back.
            tooltip={`Current branch: ${label}`}
            tooltipPlacement="bottom"
        >
            {!model.busy && <Version aria-hidden="true" className={styles.icon} />}
            <Text weight="medium" truncate className={styles.label}>
                {label}
            </Text>
            <ChevronDown aria-hidden="true" className={styles.chevron} />
        </Button>
    );

    return (
        <PopoverTrigger
            isOpen={isOpen}
            onOpenChange={open => {
                setIsOpen(open);
                setCreating(false);

                if (open) {
                    model.dismiss();
                    void model.load();
                }
            }}
        >
            {trigger}
            <Popover placement="bottom start" width={288} spacing="xs" aria-label="Branches">
                {creating ? (
                    <NewBranchForm
                        model={model}
                        starts={newBranchStarts(model.listing, head)}
                        onBack={() => showCreate(false)}
                        onSwitched={() => setIsOpen(false)}
                    />
                ) : (
                    <BranchList
                        model={model}
                        current={head?.kind === 'branch' ? head.name : undefined}
                        onSwitched={() => setIsOpen(false)}
                        onCreate={() => showCreate(true)}
                    />
                )}
            </Popover>
        </PopoverTrigger>
    );
}
