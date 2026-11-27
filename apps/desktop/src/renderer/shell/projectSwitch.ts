import type { Project } from '@clowdy/protocol';

/** The keys that switch project: the personal space on 0, then the person's projects in the order of the project menu on 1 to 9. */
export const PROJECT_SLOTS = 10;

export const projectSwitchCommand = (slot: number) => `projects.switch.${slot}`;

/** By the physical key (`Digit1`): with Option held, a Mac types a symbol on the key, and the key event names no digit. */
export const projectSwitchKeys = (slot: number) => `$mod+Alt+Digit${slot}`;

export const projectSwitchTitle = (slot: number) => (slot === 0 ? 'Switch to Personal' : `Switch to space ${slot}`);

/** The project a slot's keys open, or `undefined` while no project is on it. */
export function projectAtSlot(projects: readonly Project[], slot: number): Project | undefined {
    if (slot === 0) return projects.find(project => project.personal);

    return projects.filter(project => !project.personal)[slot - 1];
}

/** The slot of a project, or `undefined` when it is past the last key (the tenth project and the ones after it have none). */
export function slotOfProject(
    projects: readonly Project[],
    project: Pick<Project, 'id' | 'personal'>
): number | undefined {
    if (project.personal) return 0;

    const slot =
        projects.filter(candidate => !candidate.personal).findIndex(candidate => candidate.id === project.id) + 1;

    return slot > 0 && slot < PROJECT_SLOTS ? slot : undefined;
}

/**
 * Whether the project keys may run where the window is now. The keys also run over Settings, where the list of projects shows them, but not over another window or a
 * popover (a confirmation, a folder picker, a menu): what is in front of the person has their attention, and the project must not change under it.
 * The markers are the ones the key dispatcher reads (`isOverlayOpen`): a `Modal` overlay, and a popover or a dialog in it.
 */
export function projectKeysMayRun(settingsOpen: boolean): boolean {
    if (document.querySelector('[data-modal-clickout-layer], [role="dialog"], [role="alertdialog"]')) return false;

    const overlays = document.querySelectorAll('[data-modal-overlay]').length;

    return overlays === 0 || (overlays === 1 && settingsOpen);
}
