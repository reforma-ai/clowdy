import { Button } from '@clowdy/components/Button';
import { Separator } from '@clowdy/components/Separator';
import { Plus } from '@clowdy/icons/14';
import { useEffect, useRef, useState } from 'react';

import { PickerPopover, type PickerPopoverProps } from '../../shared/PickerPopover';
import styles from '../changes/BranchPicker.module.css';
import { newBranchStarts } from '../changes/branchChoices';
import { NewBranchForm } from '../changes/NewBranchForm';
import ownStyles from './BranchPickerWithCreate.module.css';

import type { GitHead } from '@clowdy/protocol';
import type { BranchSwitch } from '../changes/BranchSwitch';

export function BranchPickerWithCreate({
    model,
    head,
    footer,
    onPick,
    onClose,
    ...props
}: PickerPopoverProps & { model?: BranchSwitch; head?: GitHead }) {
    const [creating, setCreating] = useState(false);
    const mounted = useRef(true);
    const generation = useRef(0);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const showCreate = (value: boolean) => {
        generation.current++;
        model?.dismiss();
        setCreating(value);
    };
    const currentGeneration = generation.current;
    return (
        <PickerPopover
            {...props}
            onPick={onPick}
            onClose={onClose}
            content={
                creating && model ? (
                    <NewBranchForm
                        model={model}
                        createOnly
                        starts={newBranchStarts(model.listing, head)}
                        onBack={() => showCreate(false)}
                        onSwitched={branch => {
                            if (!mounted.current || generation.current !== currentGeneration) return;
                            onPick(branch);
                            onClose();
                        }}
                    />
                ) : undefined
            }
            footer={
                <>
                    {footer}
                    {model && (
                        <div className={ownStyles.footer}>
                            <Separator spacing={0} />
                            <Button
                                variant="filling"
                                color="secondary"
                                size="sm"
                                fullWidth
                                className={styles.action}
                                contentClassName={styles.actionContent}
                                isDisabled={!model.listing}
                                onPress={() => showCreate(true)}
                            >
                                <Plus aria-hidden="true" />
                                New branch…
                            </Button>
                        </div>
                    )}
                </>
            }
        />
    );
}
