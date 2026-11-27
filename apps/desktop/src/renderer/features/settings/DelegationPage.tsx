import { toast } from '@clowdy/components/Toast';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';

import { useAgents, useRootStore } from '../../stores';
import { ModelPicker } from '../chats/ModelPicker';
import { useModelChoice } from '../chats/useModelChoice';
import { SharedAgentSwitch } from './SharedAgentSwitch';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

import type { DelegationSettings } from '@clowdy/protocol';

const ROLES = ['default', 'research', 'code', 'review'] as const;
const LABELS = { default: 'Default', research: 'Research', code: 'Code', review: 'Review' };
const DESCRIPTIONS = {
    default: 'Threads without a role and roles that use the default',
    research: 'Investigate questions, explore code and gather information',
    code: 'Implement changes and fix issues',
    review: 'Review changes and check results',
};

export const DelegationPage = observer(function DelegationPage() {
    const root = useRootStore();
    const { status } = useAgents();
    const models = useModelChoice({ chat: undefined, made: undefined, run: undefined });
    const [settings, setSettings] = useState<DelegationSettings>();
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let live = true;
        void root.transport
            .getRootSnapshot()
            .then(snapshot => {
                if (live) setSettings(snapshot.delegation ?? {});
            })
            .catch(error => toast.error({ message: String(error) }));
        return () => {
            live = false;
        };
    }, [root]);

    async function save(next: DelegationSettings) {
        setSaving(true);
        const result = await root.command({ type: 'settings.setDelegation', settings: next });
        if (result.ok) {
            setSettings(next);
        } else toast.error({ message: result.error.message });
        setSaving(false);
    }

    return (
        <SettingsPage description="Choose agents for new threads">
            <SettingsSection title="Native subagents">
                <SettingsCard>
                    <SharedAgentSwitch
                        id="subagents"
                        title="Enable native subagents"
                        description="Allow supported agents to start subagents within a run"
                    />
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Thread roles">
                <SettingsCard divided>
                    {ROLES.map(role => {
                        const selected = settings?.[role];
                        const selectedAlternative =
                            selected?.kind === 'model'
                                ? undefined
                                : (selected?.kind ?? (role === 'default' ? 'inherit' : 'default'));
                        const choice = selected?.kind === 'model' ? selected : { engine: models.choice?.engine ?? '' };
                        const options = [
                            ...(role === 'default' ? [] : [{ id: 'default', label: 'Use default' }]),
                            { id: 'inherit', label: 'Inherit orchestrator' },
                        ];
                        return (
                            <SettingsRow
                                key={role}
                                title={LABELS[role]}
                                description={DESCRIPTIONS[role]}
                                footer={
                                    selected?.kind === 'model' &&
                                    status === 'ready' &&
                                    !models.providers.some(provider => provider.id === selected.engine)
                                        ? 'The selected provider is unavailable or switched off'
                                        : undefined
                                }
                            >
                                <ModelPicker
                                    label={`${LABELS[role]} selection`}
                                    disabled={!settings || saving}
                                    choice={choice}
                                    providers={models.providers}
                                    alternatives={{
                                        selected: selectedAlternative,
                                        options,
                                        onPick: id => {
                                            if (!settings || saving) return;
                                            const next = { ...settings };
                                            if (id === 'default') delete next[role];
                                            else if (id === 'inherit') next[role] = { kind: 'inherit' };
                                            else return;
                                            void save(next);
                                        },
                                    }}
                                    onPick={choice => {
                                        if (!saving && settings && choice.model)
                                            void save({
                                                ...settings,
                                                [role]: { kind: 'model', ...choice, model: choice.model },
                                            });
                                    }}
                                />
                            </SettingsRow>
                        );
                    })}
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
});
