import { StreamdownCodeBlock } from './CodeBlock';
import { StreamdownEmphasis } from './Emphasis';
import { StreamdownImage } from './Image';
import { StreamdownInlineCode } from './InlineCode';
import { StreamdownLink } from './Link';
import { StreamdownParagraph } from './Paragraph';
import { StreamdownSection } from './Section';
import { StreamdownTable } from './Table';

import type { StreamdownProps } from 'streamdown';

export const streamdownComponents: NonNullable<StreamdownProps['components']> = {
    p: StreamdownParagraph,
    em: StreamdownEmphasis,
    section: StreamdownSection,
    inlineCode: StreamdownInlineCode,
    code: StreamdownCodeBlock,
    img: StreamdownImage,
    a: StreamdownLink,
    table: StreamdownTable,
};
