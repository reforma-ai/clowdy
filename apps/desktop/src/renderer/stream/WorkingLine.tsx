import { Shimmer } from '@clowdy/components/Shimmer';
import { ProgressLoader } from '@clowdy/icons/assets';

import styles from './ToolCard.module.css';

/** The live line at the end of a stream whose run is still going: the same line a tool call is, with the progress loader (Reforma's three moving diamonds) in front of it and the wait shimmering. */
export function WorkingLine({ text = 'Working…' }: { text?: string }) {
    return (
        <div className={ styles.root } role="status" aria-label={ text }>
            <div className={ styles.header } style={ { cursor: 'default' } }>
                <span className={ styles.icon }><ProgressLoader size={ 14 } aria-hidden /></span>
                <Shimmer as="span" className={ styles.label } duration={ 1 }>{ text }</Shimmer>
            </div>
        </div>
    );
}
