import { Marker, MarkerContent, MarkerIcon } from '@clowdy/components/Marker';
import { BoltFilled } from '@clowdy/icons/14';

import { formatMessageTime } from '../shared/time';
import styles from './NoteLine.module.css';

export interface NoteLineProps {
    text: string;
    at: number;
}

/** A system line in the stream, such as "Background command finished: bun test". */
export function NoteLine({ text, at }: NoteLineProps) {
    return (
        <Marker className={styles.note} title={`Recorded at ${formatMessageTime(at)}`}>
            <MarkerIcon>
                <BoltFilled />
            </MarkerIcon>
            <MarkerContent>{text}</MarkerContent>
        </Marker>
    );
}
