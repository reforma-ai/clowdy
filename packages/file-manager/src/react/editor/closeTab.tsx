import { Modal } from '@clowdy/components/Modal';

import { basename } from '../../paths';
import { SavePrompt, type SaveAnswer } from './SavePrompt';

import type { TextDocument } from '../../documents/TextDocument';
import type { FileManager } from '../../FileManager';

/** Asks whether to save before closing; `null` means cancel. */
function askToSave(name: string): Promise<SaveAnswer | null> {
    return new Promise(resolve => {
        let answer: SaveAnswer | null = null;

        Modal.create({
            shadow: true,
            width: 400,
            clickOut: true,
            closeOnEscape: true,
            closeButton: false,
            component: (
                <SavePrompt
                    name={name}
                    onAnswer={value => {
                        answer = value;
                    }}
                />
            ),
            onClose: () => resolve(answer),
        });
    });
}

/** Closes a tab, asking first about unsaved edits. */
export async function closeTab(manager: FileManager, document: TextDocument): Promise<void> {
    if (document.dirty) {
        const answer = await askToSave(basename(document.path));

        if (!answer || (answer === 'save' && !(await document.save()))) {
            return;
        }
    }

    manager.close(document.path);
}
