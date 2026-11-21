import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';

import { chosenApp, openWithPreferences, useOpenApps } from '../openWith';
import styles from './FilesPage.module.css';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

import type { OpenApp } from '../../../shared/bridge';

const EDITOR_LABEL = 'Default IDE';
const FILE_MANAGER_LABEL = 'Default file manager';

function AppSelect({ label, apps, selectedId, onSelect }: { label: string; apps: readonly OpenApp[]; selectedId: string | undefined; onSelect: (id: string) => void }) {
    const selected = chosenApp(apps, selectedId);

    return (
        <Select
            aria-label={ label }
            size="sm"
            className={ styles.select }
            placeholder="None found"
            isDisabled={ apps.length === 0 }
            items={ apps }
            selectedKey={ selected?.id ?? null }
            onSelectionChange={ (key: unknown) => typeof key === 'string' && onSelect(key) }
        >
            { app => <ListBoxItem id={ app.id } text={ app.name } /> }
        </Select>
    );
}

/**
 * Settings > Files: the programs that open a folder, from the line under the message box of a chat. Only the programs this computer has are offered, the
 * first of each list until the person picks another; a page outside the desktop app finds none.
 */
export function FilesPage() {
    const apps = useOpenApps();

    return (
        <SettingsPage title="Files" description="Choose the programs that open your folders">
            <SettingsSection title="Open with">
                <SettingsCard divided>
                    <SettingsRow title={ EDITOR_LABEL } description="The editor that opens a folder as a workspace">
                        <AppSelect label={ EDITOR_LABEL } apps={ apps.editors } selectedId={ openWithPreferences.editor } onSelect={ id => openWithPreferences.setEditor(id) } />
                    </SettingsRow>
                    <SettingsRow title={ FILE_MANAGER_LABEL } description="The program that shows a folder with the rest of your files">
                        <AppSelect label={ FILE_MANAGER_LABEL } apps={ apps.fileManagers } selectedId={ openWithPreferences.fileManager } onSelect={ id => openWithPreferences.setFileManager(id) } />
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
