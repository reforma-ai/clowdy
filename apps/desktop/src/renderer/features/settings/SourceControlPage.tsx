import { Switch } from '@clowdy/components/Switch';
import { observer } from 'mobx-react-lite';

import { sourceControlPreferences } from '../changes/sourceControlPreferences';
import { BranchPrefixRow } from './BranchPrefixRow';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

const COLLAPSE_DIFFS_LABEL = 'Collapse diffs by default';

export const SourceControlPage = observer(function SourceControlPage() {
    return (
        <SettingsPage>
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
