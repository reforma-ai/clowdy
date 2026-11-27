import { Button } from '@clowdy/components/Button';
import { Switch } from '@clowdy/components/Switch';
import { toast } from '@clowdy/components/Toast';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';

import { useAgents, useRootStore } from '../../stores';
import { SettingsRow } from './ui/SettingsRow';

export const SharedAgentSwitch = observer(function SharedAgentSwitch({
    id,
    title,
    description,
}: {
    id: 'subagents' | 'promptSuggestions';
    title: string;
    description: string;
}) {
    const root = useRootStore();
    const { agents, status, refresh } = useAgents();
    const [saving, setSaving] = useState(false);
    const values = agents.flatMap(
        agent => agent.settings?.filter(setting => setting.id === id).map(setting => setting.value) ?? []
    );
    const mixed = values.some(Boolean) && values.some(value => !value);
    async function setEnabled(enabled: boolean) {
        setSaving(true);
        const result = await root.command({ type: 'agents.setSharedSetting', id, enabled });
        if (result.ok) await refresh();
        else toast.error({ message: result.error.message });
        setSaving(false);
    }
    return (
        <SettingsRow
            title={title}
            description={
                mixed
                    ? `${description} Providers have different saved choices until you change this switch.`
                    : description
            }
        >
            <Switch
                size="sm"
                aria-label={title}
                isSelected={values.length > 0 && values.every(Boolean)}
                isDisabled={saving || status !== 'ready'}
                onChange={enabled => void setEnabled(enabled)}
            />
            {mixed && (
                <Button size="sm" variant="inline" isDisabled={saving} onPress={() => void setEnabled(false)}>
                    Turn off for all
                </Button>
            )}
        </SettingsRow>
    );
});
