import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
import { Switch } from '@clowdy/components/Switch';

import { treeLayout } from '../files';
import { AppIcon, chosenApp, openWithPreferences, useOpenApps } from '../openWith';
import styles from './FilesPage.module.css';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

import type { OpenApp, OpenPathApp } from '../../../shared/bridge';

const EDITOR_LABEL = 'Default IDE';
const TERMINAL_LABEL = 'Default terminal';
const FILE_MANAGER_LABEL = 'Default file manager';
const HIDDEN_LABEL = 'Show hidden files';

function AppSelect({ label, kind, apps, selectedId, onSelect }: { label: string; kind: OpenPathApp['kind']; apps: readonly OpenApp[]; selectedId: string | undefined; onSelect: (id: string) => void }) {
    const selected = chosenApp(apps, selectedId);

    return (
        <Select
            aria-label={ label }
            size="sm"
            className={ styles.select }
            placeholder="None found"
            icon={ selected && <AppIcon app={ selected } kind={ kind } /> }
            isDisabled={ apps.length === 0 }
            items={ apps }
            selectedKey={ selected?.id ?? null }
            onSelectionChange={ (key: unknown) => typeof key === 'string' && onSelect(key) }
        >
            { app => <ListBoxItem id={ app.id } text={ app.name } icon={ <AppIcon app={ app } kind={ kind } /> } /> }
        </Select>
    );
}

/**
 * Settings > Files: how the file tree of the side panel shows a folder, and the programs that open a folder, from the line under the message box of a chat.
 * Only the programs this computer has are offered, the first of each list until the person picks another; a page outside the desktop app finds none.
 */
export function FilesPage() {
    const apps = useOpenApps();

    return (
        <SettingsPage title="Files" description="Choose how files are shown, and the programs that open your folders">
            <SettingsSection title="File tree">
                <SettingsCard>
                    <SettingsRow title={ HIDDEN_LABEL } description="Files that start with a dot, and node_modules">
                        <Switch size="sm" isSelected={ treeLayout.showHidden } aria-label={ HIDDEN_LABEL } onChange={ show => treeLayout.setShowHidden(show) } />
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Open with">
                <SettingsCard divided>
                    <SettingsRow title={ EDITOR_LABEL } description="The editor that opens a folder as a workspace">
                        <AppSelect label={ EDITOR_LABEL } kind="editor" apps={ apps.editors } selectedId={ openWithPreferences.editor } onSelect={ id => openWithPreferences.setEditor(id) } />
                    </SettingsRow>
                    <SettingsRow title={ FILE_MANAGER_LABEL } description="The program that shows a folder with the rest of your files">
                        <AppSelect label={ FILE_MANAGER_LABEL } kind="fileManager" apps={ apps.fileManagers } selectedId={ openWithPreferences.fileManager } onSelect={ id => openWithPreferences.setFileManager(id) } />
                    </SettingsRow>
                    <SettingsRow title={ TERMINAL_LABEL } description="The terminal that opens a shell in a folder">
                        <AppSelect label={ TERMINAL_LABEL } kind="terminal" apps={ apps.terminals } selectedId={ openWithPreferences.terminal } onSelect={ id => openWithPreferences.setTerminal(id) } />
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
