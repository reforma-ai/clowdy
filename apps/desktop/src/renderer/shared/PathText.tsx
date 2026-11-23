import { Text } from '@clowdy/components/Text';
import { cn } from '@clowdy/lib';
import { useLayoutEffect, useMemo, useRef } from 'react';

import { pathVariants, tildePath } from './displayPath';
import { homeFolder } from './homeFolder';
import styles from './PathText.module.css';

import type { TextColor, TextVariant } from '@clowdy/components/Text';

export interface PathTextProps {
    /** The absolute path of a folder or a file, as the daemon knows it. */
    path: string;
    variant?: TextVariant;
    color?: TextColor;
    className?: string;
}

/**
 * A path as a line of one row: the home folder as `~`, and, when the row is too narrow for it, the middle names left out (`~/Foo/…/baz/foo`) by whole names, the
 * longest form that fits (`pathVariants`). It measures its own row and again whenever the row changes its width; where nothing is short (a test without layout) it
 * shows the whole path. The words are set on the element, not drawn by React, because the form follows the width and not the props. Hover tells the whole path.
 * It must stand where its width is set from outside (a flex item, or a block): a row that grows with its text has no too narrow.
 */
export function PathText({ path, variant, color, className }: PathTextProps) {
    const home = homeFolder.path;
    const line = useRef<HTMLSpanElement>(null);
    const forms = useMemo(() => pathVariants(tildePath(path, home)), [path, home]);

    useLayoutEffect(() => {
        const element = line.current;

        if (!element) return;

        // The first form that fits stays; when none does, the shortest stays and the end of it is cut by the ellipsis of the style.
        const fit = () => {
            for (const form of forms) {
                element.textContent = form;

                if (element.scrollWidth <= element.clientWidth + 1) return;
            }
        };

        fit();

        const row = element.parentElement;

        if (!row || typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(fit);

        observer.observe(row);

        return () => observer.disconnect();
    }, [forms]);

    return (
        <Text
            ref={line}
            variant={variant}
            color={color}
            truncate
            title={path}
            aria-label={path}
            className={cn(styles.path, className)}
        />
    );
}
