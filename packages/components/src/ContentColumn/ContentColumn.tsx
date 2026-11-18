import { cn } from '@clowdy/lib';

import styles from './ContentColumn.module.css';

import type { ComponentPropsWithRef } from 'react';

export type ContentColumnProps = ComponentPropsWithRef<'div'>;

/**
 * Keeps content at the app's reading width (`--content-width`, one value for every page) and centred in the room it has.
 * Put it directly inside the scroll container, never around it: the container then spans the whole width, so its scrollbar
 * stays at the edge, and only the content is held in the middle. It sets the width and the centring and nothing else:
 * padding, gaps and the direction of its children are the caller's. A subtree that needs another width sets `--content-width` itself.
 */
export function ContentColumn({ className, ...props }: ContentColumnProps) {
    return <div { ...props } className={ cn(styles.column, className) } />;
}
