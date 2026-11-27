import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
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

export const DelegationPage = observer(function DelegationPage() {
    const root = useRootStore();
    const { status } = useAgents();
    const models = useModelChoice({ chat: undefined, made: undefined, run: undefined });
    const [settings, setSettings] = useState<DelegationSettings>();
    const [saving, setSaving] = useState(false);
    const [choosing, setChoosing] = useState<(typeof ROLES)[number]>();

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
            setChoosing(undefined);
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
                <SettingsCard>
                    {ROLES.map(role => {
                        const selected = settings?.[role];
                        const kind =
                            choosing === role
                                ? 'model'
                                : (selected?.kind ?? (role === 'default' ? 'inherit' : 'default'));
                        const choice =
                            choosing === role
                                ? models.choice && { engine: models.choice.engine }
                                : selected?.kind === 'model'
                                  ? selected
                                  : undefined;
                        const options = [
                            ...(role === 'default' ? [] : [{ id: 'default', label: 'Use default' }]),
                            { id: 'inherit', label: 'Inherit orchestrator' },
                            { id: 'model', label: 'Choose model' },
                        ];
                        return (
                            <SettingsRow
                                key={role}
                                title={LABELS[role]}
                                footer={
                                    selected?.kind === 'model' &&
                                    status === 'ready' &&
                                    !models.providers.some(provider => provider.id === selected.engine)
                                        ? 'The selected provider is unavailable or switched off'
                                        : undefined
                                }
                            >
                                <Select
                                    aria-label={`${LABELS[role]} selection`}
                                    size="sm"
                                    items={options}
                                    selectedKey={kind}
                                    isDisabled={!settings || saving}
                                    onSelectionChange={(key: unknown) => {
                                        if (!settings) return;
                                        const next = { ...settings };
                                        if (key === 'model') {
                                            setChoosing(role);
                                            return;
                                        }
                                        if (key === 'default') delete next[role];
                                        else if (key === 'inherit') next[role] = { kind: 'inherit' };
                                        else return;
                                        void save(next);
                                    }}
                                >
                                    {option => <ListBoxItem id={option.id} text={option.label} />}
                                </Select>
                                {kind === 'model' && !choice && 'No available provider'}
                                {kind === 'model' && choice && (
                                    <ModelPicker
                                        choice={choice}
                                        providers={models.providers}
                                        onPick={choice => {
                                            if (!saving && settings && choice.model)
                                                void save({
                                                    ...settings,
                                                    [role]: { kind: 'model', ...choice, model: choice.model },
                                                });
                                        }}
                                    />
                                )}
                            </SettingsRow>
                        );
                    })}
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
});
