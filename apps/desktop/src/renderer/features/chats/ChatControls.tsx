import styles from './ChatControls.module.css';

import type { ReactNode } from 'react';

/**
 * The line under the message box that says where a chat works and how it starts: the folder now, a branch and where it runs later. The new-chat page and the chat
 * that page makes both draw it in this place, the page with controls that change, the chat with the same ones read only, so the line stays where it was when the chat starts.
 * `end` is the actions at the right of the line, which stay as they are in a chat: the mode.
 */
export function ChatControls({ children, end }: { children?: ReactNode; end?: ReactNode }) {
    return (
        <div className={styles.controls}>
            {children}
            {end && <div className={styles.end}>{end}</div>}
        </div>
    );
}
