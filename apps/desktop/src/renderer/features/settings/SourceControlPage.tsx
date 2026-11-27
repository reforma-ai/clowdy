import { Button } from '@clowdy/components/Button';
import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { Switch } from '@clowdy/components/Switch';
import { toast } from '@clowdy/components/Toast';
import { COMMIT_MESSAGE_PROVIDERS, commitMessageAgent, writesCommitMessages } from '@clowdy/protocol';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';

import { useAgents, useRootStore } from '../../stores';
import { sourceControlPreferences } from '../changes/sourceControlPreferences';
import { BranchPrefixRow } from './BranchPrefixRow';

import type { CommitMessageProvider } from '@clowdy/protocol';

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
        <SettingsLayout.Page>
            <SettingsLayout.Section title="Commits">
                <SettingsLayout.Card>
                    <SettingsLayout.Row
                        title="Commit message provider"
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
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>
            <SettingsLayout.Section title="Sync">
                <SettingsLayout.Card>
                    <SettingsLayout.Row
                        title="Sync after commit and merge"
                        description="Bring in new commits from origin and send yours after committing or merging branches"
                    >
                        <Switch
                            size="sm"
                            isSelected={sourceControlPreferences.autoSync}
                            onChange={enabled => sourceControlPreferences.setAutoSync(enabled)}
                        />
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>
            <SettingsLayout.Section title="New worktrees">
                <SettingsLayout.Card>
                    <BranchPrefixRow />
                </SettingsLayout.Card>
            </SettingsLayout.Section>
            <SettingsLayout.Section title="Diffs">
                <SettingsLayout.Card>
                    <SettingsLayout.Row
                        title="Collapse diffs by default"
                        description="Show file headers when you open Changes"
                    >
                        <Switch
                            size="sm"
                            isSelected={sourceControlPreferences.collapseDiffs}
                            onChange={collapse => sourceControlPreferences.setCollapseDiffs(collapse)}
                        />
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>
        </SettingsLayout.Page>
    );
});
