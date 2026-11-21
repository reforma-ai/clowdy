import styles from './ChatControls.module.css';

import type { ReactNode } from 'react';

/**
 * The line under the message box that says where a chat works and how it starts: the folder now, a branch and where it runs later. The new-chat page and the chat
 * that page makes both draw it in this place, the page with controls that change, the chat with the same ones read only, so the line stays where it was when the chat starts.
 */
export function ChatControls({ children }: { children: ReactNode }) {
    return <div className={ styles.controls }>{ children }</div>;
}
