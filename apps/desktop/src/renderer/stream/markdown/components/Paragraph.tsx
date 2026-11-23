import { sanitizeStreamdownProps } from '../sanitizeStreamdownProps';

import type { ExtraProps } from 'streamdown';

/** `div` — Streamdown inline file chips render block-level RAC nodes; `p` > `div` breaks hydration. */
export function StreamdownParagraph(props: ExtraProps) {
    return <div data-streamdown="p" {...sanitizeStreamdownProps(props)} />;
}
