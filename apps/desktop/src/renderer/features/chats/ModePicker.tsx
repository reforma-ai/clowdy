import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Check, ChevronDown } from '@clowdy/icons/14';
import { use } from 'react';
import { OverlayTriggerStateContext } from 'react-aria-components';

import styles from './ModePicker.module.css';

import type { ChatMode } from '@clowdy/protocol';

const MODES: ReadonlyArray<{ id: ChatMode; label: string; description: string }> = [
    { id: 'autopilot', label: 'Hands-off', description: 'Decides on its own, asks only when stuck' },
    { id: 'semi', label: 'Hands-on', description: 'Asks you at key decisions, then carries on' },
];

export interface ModePickerProps {
    mode: ChatMode;
    /** The mode cannot change now (the orchestrator works, or the chat is being made): the pill stays and does not open. */
    isDisabled?: boolean;
    onPick: (mode: ChatMode) => void;
}

/** The pill in the composer that says how the orchestrator works, and opens the two modes with what each does. */
export function ModePicker({ mode, isDisabled, onPick }: ModePickerProps) {
    return (
        <MenuTrigger>
            <Trigger label={ MODES.find(option => option.id === mode)?.label ?? mode } isDisabled={ isDisabled } />
            <Popover className={ styles.menu } placement="top" spacing="xs">
                <Menu
                    aria-label="How the orchestrator works"
                    className={ styles.list }
                    size="sm"
                    selectionMode="single"
                    selectedKeys={ [mode] }
                    disallowEmptySelection
                    onSelectionChange={ (keys) => {
                        const next = keys === 'all' ? undefined : MODES.find(option => keys.has(option.id));

                        if (next && next.id !== mode) onPick(next.id);
                    } }
                >
                    { MODES.map(option => (
                        <MenuItem
                            key={ option.id }
                            id={ option.id }
                            className={ styles.item }
                            text={ option.label }
                            description={ option.description }
                            stacked
                            endAffix={ mode === option.id ? <Check aria-hidden="true" /> : undefined }
                        />
                    )) }
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}

function Trigger({ label, isDisabled }: { label: string; isDisabled?: boolean }) {
    const isOpen = use(OverlayTriggerStateContext)!.isOpen;

    return (
        <Button
            size="sm"
            variant="filling"
            rounded
            className={ styles.trigger }
            contentClassName={ styles.triggerContent }
            data-open={ isOpen || undefined }
            isDisabled={ isDisabled }
            aria-label={ `Mode: ${ label }` }
        >
            <Text truncate>{ label }</Text>
            <ChevronDown aria-hidden="true" />
        </Button>
    );
}
