import { sanitizeStreamdownProps } from '../sanitizeStreamdownProps';

import type { ExtraProps } from 'streamdown';

export function StreamdownEmphasis(props: ExtraProps) {
    return <em data-streamdown="em" {...sanitizeStreamdownProps(props)} />;
}
