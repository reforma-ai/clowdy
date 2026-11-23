import type { Provider } from './types';

export const grok: Provider = {
    spec: {
        id: 'grok',
        name: 'Grok Build',
        programs: ['grok'],
        launch: { kind: 'binary', args: ['agent', 'stdio'] },
    },
};
