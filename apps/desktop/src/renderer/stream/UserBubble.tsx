import { formatTime } from '../shared/time';
import styles from './UserBubble.module.css';

export interface UserBubbleProps {
    text: string;
    at: number;
}

/** What the person wrote: a tinted bubble on the right, the time under it. */
export function UserBubble({ text, at }: UserBubbleProps) {
    return (
        <div className={ styles.row }>
            <div className={ styles.bubble }>{ text }</div>
            <time className={ styles.time } dateTime={ new Date(at).toISOString() }>{ formatTime(at) }</time>
        </div>
    );
}
