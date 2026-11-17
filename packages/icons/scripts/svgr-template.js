/**
 * iconContext: { defaultWidth, defaultHeight } – prefer pack defaultSize, else from viewBox/width+height attrs
 */
export default function template(variables, { tpl }, iconContext = { defaultWidth: 16, defaultHeight: 16 }) {
    const { defaultWidth, defaultHeight } = iconContext;

    return tpl`
${ variables.imports };

import { IconWrapper, type IconProps } from '../IconBase.js';

export const ${ variables.componentName } = ({ width = ${ String(defaultWidth) }, height = ${ String(defaultHeight) }, ...rest }: IconProps) => {
    const props = { width, height, ...rest };
    const svg = ${ variables.jsx };
    return <IconWrapper {...props}>{svg}</IconWrapper>;
};
`;
}
