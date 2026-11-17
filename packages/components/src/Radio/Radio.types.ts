import { createContext } from 'react';

export type RadioSize = 'sm' | 'md' | 'lg';

export interface RadioContextValue {
    size: RadioSize;
}

export const RadioContext = createContext<RadioContextValue | null>(null);
