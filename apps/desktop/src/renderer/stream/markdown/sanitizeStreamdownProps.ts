import type { ExtraProps } from 'streamdown';

/** HAST `node` is not a valid DOM prop; strip it before spreading onto DOM nodes. */
export function sanitizeStreamdownProps<T extends ExtraProps>(props: T): Omit<T, 'node'> {
    const { node: _node, ...rest } = props;

    return rest;
}
