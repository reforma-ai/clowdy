import type { Provider } from './types';

export const hermes: Provider = {
    spec: {
        id: 'hermes',
        name: 'Hermes Agent',
        programs: ['hermes'],
        launch: { kind: 'binary', args: ['acp'] },
        login: 'hermes login',
    },
};
