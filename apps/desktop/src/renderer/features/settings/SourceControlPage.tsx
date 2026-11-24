import { Button } from '@clowdy/components/Button';
import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
import { Switch } from '@clowdy/components/Switch';
import { toast } from '@clowdy/components/Toast';
import { COMMIT_MESSAGE_PROVIDERS, commitMessageAgent, writesCommitMessages } from '@clowdy/protocol';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';

import { useAgents, useRootStore } from '../../stores';
import { sourceControlPreferences } from '../changes/sourceControlPreferences';
import { BranchPrefixRow } from './BranchPrefixRow';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

import type { CommitMessageProvider } from '@clowdy/protocol';

const COLLAPSE_DIFFS_LABEL = 'Collapse diffs by default';
const AUTO_PUSH_LABEL = 'Push after commit and merge';
const PROVIDER_LABEL = 'Commit message provider';
const PROVIDER_NAMES: Record<CommitMessageProvider, string> = { codex: 'Codex', claude: 'Claude Code' };
const PROVIDER_OPTIONS = [
    { id: 'off', label: 'Off', provider: null },
    ...COMMIT_MESSAGE_PROVIDERS.map(id => ({ id, label: PROVIDER_NAMES[id], provider: id })),
];

export const SourceControlPage = observer(function SourceControlPage() {
    const root = useRootStore();
    const { agents, status, refresh } = useAgents();
    const [saving, setSaving] = useState(false);
    const selected = commitMessageAgent(agents);

    async function selectProvider(provider: CommitMessageProvider | null) {
        setSaving(true);
        const result = await root.command({ type: 'agents.setCommitMessageProvider', provider });

        if (result.ok) await refresh();
        else toast.error({ message: result.error.message });

        setSaving(false);
    }

    return (
        <SettingsPage>
            <SettingsSection title="Commits">
                <SettingsCard>
                    <SettingsRow
                        title={PROVIDER_LABEL}
                        description="Generate sends selected changes to this provider"
                        footer={
                            selected &&
                            !writesCommitMessages(selected) && (
                                <Button
                                    variant="inline"
                                    color="primary"
                                    size="sm"
                                    onPress={() => root.ui.openSettings('providers')}
                                >
                                    Set up {selected.name} in Providers
                                </Button>
                            )
                        }
                    >
                        <Select
                            aria-label={PROVIDER_LABEL}
                            aria-busy={saving || undefined}
                            size="sm"
                            isDisabled={saving || status !== 'ready'}
                            items={PROVIDER_OPTIONS}
                            selectedKey={selected?.id ?? 'off'}
                            onSelectionChange={(key: unknown) => {
                                const choice = PROVIDER_OPTIONS.find(option => option.id === key);

                                if (choice) void selectProvider(choice.provider);
                            }}
                        >
                            {option => <ListBoxItem id={option.id} text={option.label} />}
                        </Select>
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Sync">
                <SettingsCard>
                    <SettingsRow
                        title={AUTO_PUSH_LABEL}
                        description="Push to origin after committing or merging branches in Source Control"
                    >
                        <Switch
                            size="sm"
                            aria-label={AUTO_PUSH_LABEL}
                            isSelected={sourceControlPreferences.autoPush}
                            onChange={enabled => sourceControlPreferences.setAutoPush(enabled)}
                        />
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="New worktrees">
                <SettingsCard>
                    <BranchPrefixRow />
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Diffs">
                <SettingsCard>
                    <SettingsRow title={COLLAPSE_DIFFS_LABEL} description="Show file headers when you open Changes">
                        <Switch
                            size="sm"
                            aria-label={COLLAPSE_DIFFS_LABEL}
                            isSelected={sourceControlPreferences.collapseDiffs}
                            onChange={collapse => sourceControlPreferences.setCollapseDiffs(collapse)}
                        />
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
});
