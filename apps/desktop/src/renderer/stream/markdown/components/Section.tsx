import { sanitizeStreamdownProps } from '../sanitizeStreamdownProps';

import type { ExtraProps } from 'streamdown';

export function StreamdownSection(props: ExtraProps) {
    return <section data-streamdown="section" { ...sanitizeStreamdownProps(props) } />;
}
