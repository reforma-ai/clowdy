import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger, SubmenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Switch } from '@clowdy/components/Switch';
import { Check, ChevronRight, More } from '@clowdy/icons/14';

import { openAddFolderDialog } from '../../shell/AddFolderDialog';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { addFolders } from '../settings/projects/projectActions';
import { chatListPreferences } from './chatListPreferences';
import styles from './ProjectMenu.module.css';

const layouts = [
    { id: 'simple', label: 'Simple list' },
    { id: 'folder', label: 'By folder' },
    { id: 'worktree', label: 'By worktree' },
] as const;

/** Project actions and the display options for its chat list. */
export function ProjectMenu() {
    const root = useRootStore();
    const project = useProjectState().project;
    const ui = useProjectUi();
    const { showFinishedThreads, expandRunningAgents, showUnusedWorktrees } = chatListPreferences;
    const layout = ui.groupByWorktree ? 'worktree' : ui.groupByFolder ? 'folder' : 'simple';
    const layoutLabel = layouts.find(option => option.id === layout)!.label;
    const filters = [
        ...(showFinishedThreads ? ['completed'] : []),
        ...(expandRunningAgents ? ['active'] : []),
        ...(showUnusedWorktrees ? ['unused'] : []),
    ];

    const addFolder = () => {
        openAddFolderDialog(root.transport, paths => void addFolders(root, project, paths));
    };

    return (
        <MenuTrigger>
            <Button variant="filling" size="sm" iconOnly aria-label="Project menu" tooltip="Project menu">
                <More />
            </Button>
            <Popover placement="bottom end" spacing="xs" width={290}>
                <Menu aria-label="Project menu" size="sm">
                    {!project.personal && <MenuItem id="add-folder" text="Add…" onAction={addFolder} />}
                    <MenuItem
                        id="settings"
                        text="Project settings…"
                        onAction={() => root.ui.openProjectSettings(project.id)}
                    />
                    <MenuSeparator />
                    <SubmenuTrigger>
                        <MenuItem
                            id="layout"
                            text="Layout"
                            endAffix={
                                <span className={styles.summary}>
                                    {layoutLabel} <ChevronRight />
                                </span>
                            }
                        />
                        <Popover spacing="xs" width={240}>
                            <Menu
                                aria-label="Layout"
                                size="sm"
                                selectionMode="single"
                                disallowEmptySelection
                                selectedKeys={[layout]}
                                onSelectionChange={keys => {
                                    const selected = keys === 'all' ? undefined : [...keys][0];
                                    if (selected === 'simple' || selected === 'folder' || selected === 'worktree')
                                        ui.setChatListLayout(selected);
                                }}
                            >
                                {layouts.map(option => (
                                    <MenuItem
                                        key={option.id}
                                        id={option.id}
                                        text={option.label}
                                        endAffix={layout === option.id ? <Check /> : undefined}
                                    />
                                ))}
                            </Menu>
                        </Popover>
                    </SubmenuTrigger>
                    <SubmenuTrigger>
                        <MenuItem id="display" text="Display" endAffix={<ChevronRight />} />
                        <Popover spacing="xs" width={260}>
                            <Menu aria-label="Display" size="sm">
                                <MenuSection
                                    selectionMode="multiple"
                                    selectedKeys={filters}
                                    onSelectionChange={keys => {
                                        const on = (key: string) => keys === 'all' || keys.has(key);
                                        chatListPreferences.setShowFinishedThreads(on('completed'));
                                        chatListPreferences.setExpandRunningAgents(on('active'));
                                        chatListPreferences.setShowUnusedWorktrees(on('unused'));
                                    }}
                                >
                                    <MenuItem
                                        className={styles.displayItem}
                                        id="completed"
                                        text="Show completed threads"
                                        shouldCloseOnSelect={false}
                                        endAffix={
                                            <span inert aria-hidden className={styles.switch}>
                                                <Switch
                                                    size="sm"
                                                    aria-label="Show completed threads"
                                                    isReadOnly
                                                    isSelected={showFinishedThreads}
                                                />
                                            </span>
                                        }
                                    />
                                    <MenuItem
                                        className={styles.displayItem}
                                        id="active"
                                        text="Expand active threads"
                                        shouldCloseOnSelect={false}
                                        endAffix={
                                            <span inert aria-hidden className={styles.switch}>
                                                <Switch
                                                    size="sm"
                                                    aria-label="Expand active threads"
                                                    isReadOnly
                                                    isSelected={expandRunningAgents}
                                                />
                                            </span>
                                        }
                                    />
                                    <MenuItem
                                        className={styles.displayItem}
                                        id="unused"
                                        text="Show unused worktrees"
                                        shouldCloseOnSelect={false}
                                        endAffix={
                                            <span inert aria-hidden className={styles.switch}>
                                                <Switch
                                                    size="sm"
                                                    aria-label="Show unused worktrees"
                                                    isReadOnly
                                                    isSelected={showUnusedWorktrees}
                                                />
                                            </span>
                                        }
                                    />
                                </MenuSection>
                            </Menu>
                        </Popover>
                    </SubmenuTrigger>
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}
