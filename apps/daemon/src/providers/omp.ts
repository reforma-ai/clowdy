import type { Provider } from './types';

export const omp: Provider = {
    spec: {
        id: 'omp',
        name: 'omp',
        programs: ['omp'],
        launch: { kind: 'binary', args: ['acp'] },
        login: 'omp login',
    },
};
