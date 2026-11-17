import './styles';
import './windowChrome';

import { mount } from '@clowdy/lib/react';

import { App } from './App';
import { initTheme } from './theme';

initTheme();
mount(App, '#root');
