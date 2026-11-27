import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { toast } from '@clowdy/components/Toast';
import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';

import type { SleepMode } from '@clowdy/protocol';

const MODES: { id: SleepMode; label: string }[] = [
    { id: 'allow', label: 'Allow sleep' },
    { id: 'while-working', label: 'Keep awake while agents work' },
    { id: 'always', label: 'Always keep awake' },
];

export function SleepSettings() {
    const { transport } = useRootStore();
    const [mode, setMode] = useState<SleepMode>();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void transport.getPowerSettings().then(
            settings => {
                if (!cancelled) setMode(settings.sleepMode);
            },
            () => {
                if (!cancelled) setError(true);
            }
        );
        return () => {
            cancelled = true;
        };
    }, [transport]);

    async function selectMode(next: SleepMode) {
        setSaving(true);
        try {
            setMode((await transport.setSleepMode(next)).sleepMode);
        } catch {
            toast.error({ message: 'Could not save sleep mode' });
        } finally {
            setSaving(false);
        }
    }

    return (
        <SettingsLayout.Section title="Sleep">
            <SettingsLayout.Card>
                <SettingsLayout.Row
                    title="Sleep mode"
                    description={
                        error
                            ? 'Could not load power settings'
                            : 'Prevent idle system sleep while Clowdy runs, even with its window closed. The display can still turn off.'
                    }
                >
                    <Select
                        aria-busy={(!mode && !error) || saving || undefined}
                        size="sm"
                        isDisabled={!mode || saving}
                        items={MODES}
                        selectedKey={mode ?? null}
                        onSelectionChange={(key: unknown) => {
                            const choice = MODES.find(option => option.id === key);
                            if (choice) void selectMode(choice.id);
                        }}
                    >
                        {option => <ListBoxItem id={option.id} text={option.label} />}
                    </Select>
                </SettingsLayout.Row>
            </SettingsLayout.Card>
        </SettingsLayout.Section>
    );
}
