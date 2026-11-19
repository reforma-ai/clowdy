import { Modal } from '@clowdy/components/Modal';

import { AddProjectForm } from './AddProjectForm';

import type { RootStore } from '../stores';

/**
 * "Add project…": a name and the folders, existing ones or none for a new folder, in one form (`AddProjectForm`). No `title` option: the
 * heading is drawn in the form, bigger, as Reforma's dialogs do, and the window's own close button floats at the corner. `handle: false`
 * keeps the dialog where it opens; window-type modals can be dragged by their title bar. 460px wide: a folder's row has its path beside
 * the controls.
 */
export function openAddProject(root: RootStore): void {
    Modal.create({ width: 460, shadow: true, clickOut: true, closeOnEscape: true, closeButton: true, handle: false, component: <AddProjectForm root={ root } /> });
}
