import { Marker, MarkerContent, MarkerIcon } from '@clowdy/components/Marker';
import { Spinner } from '@clowdy/components/Spinner';

import styles from './NoteLine.module.css';

/** The live line at the end of a stream whose run is still going. */
export function WorkingLine({ text = 'Working…' }: { text?: string }) {
    return (
        <Marker className={ styles.note } role="status">
            <MarkerIcon><Spinner size="xs" /></MarkerIcon>
            <MarkerContent shimmer>{ text }</MarkerContent>
        </Marker>
    );
}
