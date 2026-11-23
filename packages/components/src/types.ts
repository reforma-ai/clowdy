export type Spacing = 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
export type Direction = 'row' | 'row-reverse' | 'column' | 'column-reverse';
export type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
export type Justify = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
export type Wrap = 'nowrap' | 'wrap' | 'wrap-reverse';

export type SemanticColor = 'primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'danger';

export type TextVariant =
    | 'xl'
    | 'lg'
    | 'md'
    | 'sm'
    | 'xs'
    | 'heading-1'
    | 'heading-2'
    | 'heading-3'
    | 'heading-4'
    | 'heading-5'
    | 'heading-6'
    | 'label'
    | 'code';

export type TextColor = SemanticColor | 'default' | 'inherit';
