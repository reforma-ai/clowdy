import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { Radio, RadioGroup } from '@clowdy/components/Radio';
import { Text } from '@clowdy/components/Text';
import { ArrowLeft } from '@clowdy/icons/14';
import { useState } from 'react';

import { canCreate, START_WORDS } from './branchChoices';
import styles from './BranchPicker.module.css';
import { SwitchReasons } from './SwitchReasons';

import type { GitSwitchStart } from '@clowdy/protocol';
import type { NewBranchStarts } from './branchChoices';
import type { BranchSwitch } from './BranchSwitch';

/** What one start of the form is called, and what it is for. */
function Choice({ start, name }: { start: GitSwitchStart; name: string | undefined }) {
    const words = START_WORDS[start];

    return (
        <span className={ styles.choice }>
            <Text weight="medium">{ words.label(name) }</Text>
            <Text variant="xs" color="secondary">{ words.description }</Text>
        </span>
    );
}

/** The form of a new branch, in GitHub Desktop's words: a name, and `Create branch based on…` the default branch or the current one. Enter creates it; a refusal is shown under the choices, and nothing closes. */
export function NewBranchForm({ model, starts, onBack, onSwitched }: { model: BranchSwitch; starts: NewBranchStarts; onBack: () => void; onSwitched: () => void }) {
    const [name, setName] = useState('');
    const [start, setStart] = useState<GitSwitchStart>(starts.default === undefined ? 'current' : 'default');
    const ready = canCreate(name, start, starts) && !model.busy;

    const create = async () => {
        if (!ready) return;

        const outcome = await model.switchTo(name.trim(), { start });

        if (outcome.ok && outcome.result.warning === undefined) onSwitched();
    };

    return (
        <form className={ styles.form } onSubmit={ (event) => {
            event.preventDefault();
            void create();
        } }
        >
            <div className={ styles.formHeader }>
                <Button variant="transparent" color="secondary" size="xs" iconOnly aria-label="Back to the branches" onPress={ onBack }>
                    <ArrowLeft aria-hidden="true" />
                </Button>
                <Text weight="medium">Create a branch</Text>
            </div>

            <FormField layout="vertical" size="sm">
                <FormField.Label>Name</FormField.Label>
                <Input type="text" size="sm" variant="bordered" aria-label="Name" value={ name } onChange={ setName } placeholder="feature/new-thing" autoFocus spellCheck={ false } autoCapitalize="off" />
            </FormField>

            <Text variant="xs" weight="medium" color="secondary" id="new-branch-start">Create branch based on…</Text>
            <RadioGroup size="sm" className={ styles.choices } aria-labelledby="new-branch-start" value={ start } onChange={ value => setStart(value as GitSwitchStart) }>
                <Radio value="default" className={ styles.radio } isDisabled={ starts.default === undefined }><Choice start="default" name={ starts.default } /></Radio>
                <Radio value="current" className={ styles.radio } isDisabled={ starts.current === undefined }><Choice start="current" name={ starts.current } /></Radio>
            </RadioGroup>

            <SwitchReasons model={ model } />

            <div className={ styles.actions }>
                <Button type="submit" color="primary" size="sm" isDisabled={ !ready } isPending={ model.busy }>Create branch</Button>
            </div>
        </form>
    );
}
