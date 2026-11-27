import { Button } from '@clowdy/components/Button';
import { listBoxItemDataShow, Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { ChevronDown, Folder, Home, Sliders } from '@clowdy/icons/14';
import { useRef, useState } from 'react';

import { ProjectIcon } from '../shared/ProjectIcon';
import { SCREEN_TITLE } from '../shared/screenTitle';
import { useProjectState, useRootStore } from '../stores';
import { ProjectCard, useProjectRow } from './ProjectCard';
import styles from './ProjectSelect.module.css';
import { slotOfProject } from './projectSwitch';

import type { Project } from '@clowdy/protocol';
import type { RefObject } from 'react';

const MANAGE = 'manage-projects';

/**
 * The sliders at the end of a project's row, which open the page of that project in Settings > Projects: a press target of its own that leaves the row unpressed
 * (`held` tells the menu's `onAction` that the press was the button's). It shows while the pointer is over the row. Keyboard users have "Manage projects…".
 */
function SettingsButton({
    project,
    held,
    onPress,
}: {
    project: Project;
    held: RefObject<boolean>;
    onPress: () => void;
}) {
    return (
        <Button
            variant="filling"
            color="secondary"
            size="xs"
            iconOnly
            aria-label={`${project.name} settings`}
            tooltip="Space settings"
            excludeFromTabOrder
            data-show={listBoxItemDataShow.itemHover}
            onPressStart={() => void (held.current = true)}
            onPressEnd={() => void (held.current = false)}
            onPress={onPress}
        >
            <Sliders />
        </Button>
    );
}

/**
 * The project switcher, which is the title of the list of chats: the project's icon, its name set as a screen's title is, and a chevron, with a plate only while the
 * pointer is over it. Its menu has the personal space on top, then the projects in the person's order, the open one on a plate and each with a button for its page in
 * Settings > Projects (shown on hover), and a card beside the menu, level with the row the pointer or the keyboard is on, with that project's name, keys and folders, then
 * "Manage projects…", which opens the list there, where a project is added.
 */
export function ProjectSelect() {
    const root = useRootStore();
    const project = useProjectState();
    const [isOpen, setIsOpen] = useState(false);
    const cardRow = useProjectRow(isOpen);
    // A press on a row's settings button reaches the row too, which must not switch to its project.
    const held = useRef(false);
    const selected = root.projects.find(candidate => candidate.id === project.id);
    const personal = root.projects.find(project => project.personal);
    const own = root.projects.filter(project => !project.personal);
    const cardProject = root.projects.find(project => project.id === cardRow?.dataset.projectRow);
    const settings = (project: Project) => (
        <SettingsButton
            project={project}
            held={held}
            onPress={() => {
                setIsOpen(false);
                root.ui.openProjectSettings(project.id);
            }}
        />
    );

    return (
        <MenuTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
            <Button variant="filling" size="sm" className={styles.trigger} aria-label="Space">
                {selected ? <ProjectIcon project={selected} /> : <Folder />}
                <Text variant={SCREEN_TITLE} truncate>
                    {selected?.name ?? 'No space'}
                </Text>
                <ChevronDown />
            </Button>
            <Popover placement="bottom start" width={280}>
                <Menu
                    aria-label="Spaces"
                    size="md"
                    onAction={key => {
                        // The press was the settings button's, which has done its own work.
                        if (held.current) {
                            held.current = false;

                            return;
                        }

                        if (key === MANAGE) root.ui.openProjectSettings();
                        else {
                            root.selectProject(String(key));
                            setIsOpen(false);
                        }
                    }}
                >
                    <MenuSection
                        aria-label="Spaces"
                        selectionMode="single"
                        selectedKeys={selected ? [selected.id] : []}
                        disallowEmptySelection
                    >
                        {personal && (
                            <MenuItem
                                id={personal.id}
                                text={personal.name}
                                description="For personal work"
                                icon={<Home />}
                                stacked
                                data-align="center"
                                // The row shuts the menu itself (`onAction`): a press on the settings button inside it must not.
                                shouldCloseOnSelect={false}
                                endAffix={settings(personal)}
                                data-project-row={personal.id}
                            />
                        )}
                        {personal && own.length > 0 && <MenuSeparator />}
                        {own.map(project => (
                            <MenuItem
                                key={project.id}
                                id={project.id}
                                text={project.name}
                                icon={<ProjectIcon project={project} />}
                                shouldCloseOnSelect={false}
                                endAffix={settings(project)}
                                data-project-row={project.id}
                            />
                        ))}
                    </MenuSection>
                    {root.projects.length > 0 && <MenuSeparator />}
                    <MenuItem id={MANAGE} text="Manage spaces…" icon={<Sliders />} />
                </Menu>
                {cardRow && cardProject && (
                    <ProjectCard project={cardProject} slot={slotOfProject(root.projects, cardProject)} row={cardRow} />
                )}
            </Popover>
        </MenuTrigger>
    );
}
