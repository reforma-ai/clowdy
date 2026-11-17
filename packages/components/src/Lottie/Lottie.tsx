import LottieReact from 'lottie-react';

import type { ComponentProps } from 'react';

export type LottieProps = ComponentProps<typeof LottieReact>;

const LottieModule = LottieReact as unknown as { default?: typeof LottieReact };
const Lottie: typeof LottieReact = LottieModule.default ?? LottieReact;

export { Lottie };
