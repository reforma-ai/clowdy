import { ListBoxItem } from '@clowdy/components/List';
import { Select } from '@clowdy/components/Select';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { Switch } from '@clowdy/components/Switch';

import { treeLayout } from '../files';
import { AppIcon, chosenApp, openWithPreferences, useOpenApps } from '../openWith';

import type { OpenApp, OpenPathApp } from '../../../shared/bridge';

/** A program list of a row; the row names it. */
function AppSelect({
    kind,
    apps,
    selectedId,
    onSelect,
}: {
    kind: OpenPathApp['kind'];
    apps: readonly OpenApp[];
    selectedId: string | undefined;
    onSelect: (id: string) => void;
}) {
    const selected = chosenApp(apps, selectedId);

    return (
        <Select
            size="sm"
            placeholder="None found"
            icon={selected && <AppIcon app={selected} kind={kind} />}
            isDisabled={apps.length === 0}
            items={apps}
            selectedKey={selected?.id ?? null}
            onSelectionChange={(key: unknown) => typeof key === 'string' && onSelect(key)}
        >
            {app => <ListBoxItem id={app.id} text={app.name} icon={<AppIcon app={app} kind={kind} />} />}
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
        <SettingsLayout.Page description="Choose how files are shown, and the programs that open your folders">
            <SettingsLayout.Section title="File tree">
                <SettingsLayout.Card>
                    <SettingsLayout.Row
                        title="Show hidden files"
                        description="Files that start with a dot, and node_modules"
                    >
                        <Switch
                            size="sm"
                            isSelected={treeLayout.showHidden}
                            onChange={show => treeLayout.setShowHidden(show)}
                        />
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>
            <SettingsLayout.Section title="Open with">
                <SettingsLayout.Card divided>
                    <SettingsLayout.Row
                        title="Default IDE"
                        description="The editor that opens a folder as a workspace"
                        controlWidth="14rem"
                    >
                        <AppSelect
                            kind="editor"
                            apps={apps.editors}
                            selectedId={openWithPreferences.editor}
                            onSelect={id => openWithPreferences.setEditor(id)}
                        />
                    </SettingsLayout.Row>
                    <SettingsLayout.Row
                        title="Default file manager"
                        description="The program that shows a folder with the rest of your files"
                        controlWidth="14rem"
                    >
                        <AppSelect
                            kind="fileManager"
                            apps={apps.fileManagers}
                            selectedId={openWithPreferences.fileManager}
                            onSelect={id => openWithPreferences.setFileManager(id)}
                        />
                    </SettingsLayout.Row>
                    <SettingsLayout.Row
                        title="Default terminal"
                        description="The terminal that opens a shell in a folder"
                        controlWidth="14rem"
                    >
                        <AppSelect
                            kind="terminal"
                            apps={apps.terminals}
                            selectedId={openWithPreferences.terminal}
                            onSelect={id => openWithPreferences.setTerminal(id)}
                        />
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>
        </SettingsLayout.Page>
    );
}
