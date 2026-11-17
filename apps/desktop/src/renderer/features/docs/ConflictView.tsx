import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { toast } from '@clowdy/components/Toast';
import { AttentionTriangle } from '@clowdy/icons/14';
import { useState } from 'react';

import { changedLines } from './changedLines';
import styles from './ConflictView.module.css';

import type { DiskVersion, DocBuffer } from './DocBuffer';
import type { DocsStore } from './DocsStore';

/**
 * The file changed on disk while it had unsaved edits. Both versions are shown, and nothing happens until the
 * person picks one of three ways out.
 */
export function ConflictView({ store, buffer, theirs }: { store: DocsStore; buffer: DocBuffer; theirs: DiskVersion }) {
    const [copying, setCopying] = useState(false);
    const busy = copying || buffer.saving;
    const changed = changedLines(buffer.text, theirs.content);

    const copyAndTake = async () => {
        setCopying(true);

        const copy = await store.copyMineAndTakeTheirs(buffer);

        setCopying(false);

        if (copy) toast.success({ message: `Your text was saved as ${ copy }` });
    };

    return (
        <div className={ styles.view }>
            <Alert color="warning" role="alert" className={ styles.alert }>
                <AlertIcon><AttentionTriangle /></AlertIcon>
                <AlertTitle>{ buffer.path } changed on disk while you were editing it</AlertTitle>
                <AlertDescription>
                    { buffer.removed
                        ? 'The file was removed and has come back with different text. Choose which text to keep. Nothing changes until you do.'
                        : 'Someone else saved a different version, such as an agent or another app. Choose which text to keep. Nothing changes until you do.' }
                </AlertDescription>
            </Alert>

            <div className={ styles.choices }>
                <Choice label="Keep mine" isPending={ buffer.saving } isDisabled={ busy } onPress={ () => void store.keepMine(buffer) }>
                    Overwrites the file on disk with your text.
                </Choice>
                <Choice label="Take theirs" isDisabled={ busy } onPress={ () => store.takeTheirs(buffer) }>
                    Drops your edits and shows what is on disk.
                </Choice>
                <Choice label="Copy mine, take theirs" color="primary" isPending={ copying } isDisabled={ busy } onPress={ () => void copyAndTake() }>
                    Saves your text as a new document, then shows what is on disk. Nothing is lost.
                </Choice>
            </div>

            <div className={ styles.versions }>
                <Version title="Your version" text={ buffer.text } changed={ changed.mine } />
                <Version title="On disk now" text={ theirs.content } changed={ changed.theirs } />
            </div>
        </div>
    );
}

interface ChoiceProps {
    label: string;
    color?: 'primary';
    isPending?: boolean;
    isDisabled?: boolean;
    onPress: () => void;
    children: string;
}

function Choice({ label, color, isPending, isDisabled, onPress, children }: ChoiceProps) {
    return (
        <div className={ styles.choice }>
            <Button variant="bordered" color={ color } isPending={ isPending } isDisabled={ isDisabled } onPress={ onPress }>{ label }</Button>
            <Text variant="sm" color="secondary">{ children }</Text>
        </div>
    );
}

function Version({ title, text, changed }: { title: string; text: string; changed: boolean[] }) {
    const lines = text.split('\n');

    return (
        <section className={ styles.version } aria-label={ title }>
            <Text variant="label" color="secondary" className={ styles.versionTitle }>{ title }</Text>
            <Scrollable className={ styles.scroll } contentClass={ styles.lines }>
                <ol className={ styles.list }>
                    { lines.map((line, index) => (
                        // The lines never reorder, and two can be equal, so the position is the identity.
                        <li key={ index } className={ styles.line } data-changed={ changed[index] || undefined }>
                            <span className={ styles.number } aria-hidden>{ index + 1 }</span>
                            <span className={ styles.text }>{ line }</span>
                        </li>
                    )) }
                </ol>
            </Scrollable>
        </section>
    );
}
