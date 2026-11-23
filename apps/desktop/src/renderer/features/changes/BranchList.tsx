import { Button } from '@clowdy/components/Button';
import { Separator } from '@clowdy/components/Separator';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { Plus } from '@clowdy/icons/14';
import { useMemo } from 'react';

import { homeFolder } from '../../shared/homeFolder';
import { PickerList } from '../../shared/PickerPopover';
import { branchOptions } from './branchChoices';
import styles from './BranchPicker.module.css';
import { SwitchReasons } from './SwitchReasons';

import type { BranchSwitch } from './BranchSwitch';

/** The list of the popover: the branches in their groups with a filter, and the row that opens the form of a new one. A press on a branch switches to it, and the popover shuts when that was made. */
export function BranchList({ model, current, onSwitched, onCreate }: { model: BranchSwitch; current: string | undefined; onSwitched: () => void; onCreate: () => void }) {
    const { listing } = model;
    const options = useMemo(() => (listing ? branchOptions(listing, homeFolder.path) : []), [listing]);

    const pick = async (name: string) => {
        const outcome = await model.switchTo(name);

        if (outcome.ok && outcome.result.warning === undefined) onSwitched();
        // A hook's complaint is read before the popover goes: the list is read again so it is true.
        else if (outcome.ok) void model.load();
    };

    return (
        <div className={ styles.body }>
            <Text variant="xs" weight="medium" color="secondary" className={ styles.title }>Current branch</Text>
            { listing
                ? <PickerList options={ options } selectedIds={ current === undefined ? [] : [current] } aria-label="Branches" placeholder="Filter branches" onPick={ name => void pick(name) } />
                : <div className={ styles.status } role="status">{ model.loading ? <Spinner size="xs" /> : null }<Text variant="xs" color="secondary">{ model.loading ? 'Loading branches' : 'No branches to show' }</Text></div> }
            <SwitchReasons model={ model } />
            <Separator spacing="xxs" />
            <div className={ styles.footer }>
                <Button variant="filling" color="secondary" size="sm" fullWidth className={ styles.action } isDisabled={ !listing } onPress={ onCreate }>
                    <Plus aria-hidden="true" />
                    New branch…
                </Button>
            </div>
        </div>
    );
}
