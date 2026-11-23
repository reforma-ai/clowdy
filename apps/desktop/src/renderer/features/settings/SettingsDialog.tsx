import { Dialog } from '@clowdy/components/Modal';
import { observer } from 'mobx-react-lite';

import { useRootStore } from '../../stores';
import styles from './SettingsDialog.module.css';
import { SettingsWindow } from './SettingsWindow';

/**
 * Settings, as a window that covers most of the app (`SettingsWindow`: a sidebar of pages and the page chosen in it) over whatever is on show, which stays where it is behind a dimmed
 * backdrop. It is open while `UiStore.settingsOpen` is, and every way of closing it (Esc, a click outside, its cross) shuts that. The page it shows is `settingsPage`.
 */
export const SettingsDialog = observer(function SettingsDialog() {
    const { ui } = useRootStore();

    return (
        <Dialog
            name="settings"
            isOpen={ ui.settingsOpen }
            onOpenChange={ (open) => {
                if (!open) ui.closeSettings();
            } }
            type="overlay"
            class={ styles.window }
            scrollable="hidden"
            shadow
            clickOut
            closeOnEscape
            closeButton
        >
            <SettingsWindow />
        </Dialog>
    );
});
