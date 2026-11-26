import { Button } from '@clowdy/components/Button';
import { Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { ChevronDown } from '@clowdy/icons/8';
import { Version } from '@clowdy/icons/14';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useRootStore } from '../../stores';
import { BranchList } from './BranchList';
import styles from './BranchPicker.module.css';
import { newBranchStarts } from './branchChoices';
import { openDeleteBranch } from './DeleteBranchDialog';
import { NewBranchForm } from './NewBranchForm';
import { useBranchSwitch } from './useBranchSwitch';

import type { PlaceFacts } from './gitFacts';

export interface BranchPickerProps {
    facts: PlaceFacts;
    /** The branch the place is on as the sidebar names it: the branch, or `Detached at 1a2b3c4`. */
    label: string;
    embeddedClose?: () => void;
    beginPreview?: () => () => boolean;
}

/**
 * The branch of the place as the title of the Changes sidebar and a button that changes it. The popover starts with search and lists unavailable branches at the end.
 * `New branch…` opens the form in the same popover. A press on a branch switches to it (`BranchSwitch`: the daemon refuses a tree with changes, a merge or rebase under way, a run working there and a branch held elsewhere, and
 * says why, and the reason is shown inside the popover, selectable); the popover shuts when the switch was made, never on a refusal. While a switch runs the button shows a spinner.
 * A chat worktree must also be merged into its base. The branches are read each time the popover opens.
 */
export function BranchPicker({ facts, label, embeddedClose, beginPreview }: BranchPickerProps) {
    const model = useBranchSwitch(facts);
    const { transport } = useRootStore();
    const [isOpen, setIsOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [previewing, setPreviewing] = useState(false);
    const previewRequest = useRef<symbol | undefined>(undefined);
    useLayoutEffect(() => {
        setPreviewing(false);
        return () => {
            previewRequest.current = undefined;
        };
    }, [model]);

    useEffect(() => {
        if (embeddedClose) {
            model.dismiss();
            void model.load();
        }
    }, [model, embeddedClose]);

    const close = () => (embeddedClose ? embeddedClose() : setIsOpen(false));
    const deleteBranch = async (name: string, remote: boolean) => {
        if (previewRequest.current || model.busy) return;

        const request = Symbol();
        previewRequest.current = request;
        const isCurrent = beginPreview?.() ?? (() => previewRequest.current === request);
        close();
        setPreviewing(true);
        try {
            await openDeleteBranch(model, transport, name, remote, isCurrent);
        } finally {
            if (previewRequest.current === request) {
                previewRequest.current = undefined;
                setPreviewing(false);
            }
        }
    };
    const status = facts.status.value;
    const head = status?.isRepository === true ? status.head : undefined;
    const showCreate = (on: boolean) => {
        model.dismiss();
        setCreating(on);
    };
    const trigger = (
        <Button
            variant="filling"
            color="secondary"
            size="sm"
            className={styles.trigger}
            contentClassName={styles.content}
            isPending={model.running !== undefined}
            isDisabled={previewing || (model.busy && model.running === undefined)}
            spinnerPlacement="start"
            aria-label={`Current branch: ${label}`}
            // Constant while the popover is open or not: a button that gains or loses its tooltip is drawn in another place of the tree, and would lose the focus the popover gives back.
            tooltip={`Current branch: ${label}`}
            tooltipPlacement="bottom"
        >
            {model.running === undefined && <Version aria-hidden="true" className={styles.icon} />}
            <Text weight="medium" truncate className={styles.label}>
                {label}
            </Text>
            <ChevronDown aria-hidden="true" className={styles.chevron} />
        </Button>
    );

    const content = (
        <>
            {creating ? (
                <NewBranchForm
                    model={model}
                    starts={newBranchStarts(model.listing, head)}
                    onBack={() => showCreate(false)}
                    onSwitched={close}
                />
            ) : (
                <BranchList
                    model={model}
                    current={head?.kind === 'branch' ? head.name : undefined}
                    onSwitched={close}
                    onCreate={() => showCreate(true)}
                    onDelete={(name, remote) => void deleteBranch(name, remote)}
                />
            )}
        </>
    );

    if (embeddedClose) return content;

    return (
        <PopoverTrigger
            isOpen={isOpen}
            onOpenChange={open => {
                if (open && previewRequest.current) return;
                setIsOpen(open);
                setCreating(false);

                if (open) {
                    model.dismiss();
                    void model.load();
                }
            }}
        >
            {trigger}
            <Popover
                placement="bottom start"
                width={288}
                spacing="xs"
                aria-label="Branches"
                shouldCloseOnInteractOutside={element => !element.closest('[data-branch-context-menu]')}
            >
                {content}
            </Popover>
        </PopoverTrigger>
    );
}
