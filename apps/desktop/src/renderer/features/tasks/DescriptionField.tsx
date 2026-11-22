import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';

import styles from './DescriptionField.module.css';
import { LatestSaver, onlyTicksChanged } from './descriptionSave';
import { EditableText } from './EditableText';
import { MarkdownPlate } from './MarkdownPlate';

export interface DescriptionFieldProps {
    /** The description the project holds. */
    value: string;
    /** Saves a description; resolves to whether the daemon took it. */
    onSave: (description: string) => Promise<boolean>;
}

/** Why the description is edited as plain text, and what the person is told. `null` when they chose it. */
type PlainReason = string | null;

/** Saves the draft unless the project holds it already. While a save is on its way the draft may be the text before it, so it goes after it (the saver drops what repeats). */
function saveUnsaved({ draft, value }: { draft: string; value: string }, saver: LatestSaver): void {
    if (draft !== value || saver.isBusy) void saver.save(draft);
}

/**
 * The description of a task, as a Markdown editor: a checklist line (`- [ ]`, `- [x]`) is a checkbox that is ticked in place.
 *
 * Typing is saved when the editor loses focus, and on the way out when the panel closes under it. A tick is saved at once, with whatever else was typed and not saved yet,
 * so a person who ticks several boxes loses none of them to a text that was waiting for a blur. Saves go one at a time and the newest text wins (`LatestSaver`), so
 * quick ticks arrive in order. A change from outside (an agent ticked a line) shows at once, unless the person has text of their own that is not saved: it is kept and
 * saved when they leave the field, like `EditableText`. A save the daemon refuses puts the stored text back.
 *
 * Text the editor cannot write back without changing it (HTML, footnotes, reference links) shows read-only with the editor's reason and **Edit as text**, and text it will not load
 * (over 256 KB) with its reason: both are edited as plain text, as the description was before the editor.
 */
export function DescriptionField({ value, onSave }: DescriptionFieldProps) {
    const [draft, setDraft] = useState(value);
    const [seen, setSeen] = useState(value);
    const [plain, setPlain] = useState<{ reason: PlainReason } | null>(null);
    // What the editor's callbacks and the saver read, which is the latest render's: the editor keeps the handlers it was first given.
    const latest = useRef({ draft, value, onSave });
    const [saver] = useState(() => new LatestSaver(
        text => latest.current.onSave(text),
        () => {
            // The daemon refused: what the project holds is the text again.
            latest.current.draft = latest.current.value;
            setDraft(latest.current.value);
        }
    ));

    useLayoutEffect(() => {
        latest.current = { draft, value, onSave };
    });

    useEffect(() => saver.noteStored(value), [saver, value]);

    // The draft follows the project unless the person has text of their own that is not saved yet, or a save is on its way.
    if (value !== seen) {
        setSeen(value);

        if (draft === seen && !saver.isBusy) setDraft(value);
    }

    // Gone with the panel (another task opened, Escape): a blur is not sent for an element that is removed, so what was typed is saved here.
    useEffect(() => () => saveUnsaved(latest.current, saver), [saver]);

    const edit = (text: string) => {
        const isTick = onlyTicksChanged(latest.current.draft, text);

        latest.current.draft = text;
        setDraft(text);

        if (isTick) void saver.save(text);
    };

    const leave = (event: FocusEvent<HTMLElement>) => {
        // The toolbar is inside: moving to it is not leaving.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;

        saveUnsaved(latest.current, saver);
    };

    if (plain) {
        return (
            <div className={ styles.plain }>
                { plain.reason !== null && (
                    <div className={ styles.reason }>
                        <Text variant="heading-6">This description is too big for the visual editor</Text>
                        {/* The editor ends its reason with a period; one sentence in the interface has none. */}
                        <Text color="secondary">{ plain.reason.replace(/\.$/, '') }</Text>
                    </div>
                ) }
                <EditableText variant="body" aria-label="Description" placeholder="Add a description…" value={ value } onCommit={ onSave } />
            </div>
        );
    }

    return (
        <div onBlur={ leave }>
            <MarkdownPlate
                value={ draft }
                aria-label="Description"
                onChange={ edit }
                onUnsupported={ reason => setPlain({ reason }) }
                unsupportedAction={ <Button size="sm" variant="bordered" onPress={ () => setPlain({ reason: null }) }>Edit as text</Button> }
            />
        </div>
    );
}
