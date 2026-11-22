import './styles';
import './windowChrome';

import { installLongPressContextMenu } from '@clowdy/components/Popover';
import { mount } from '@clowdy/lib/react';

import { App } from './App';
import { initTheme } from './theme';

initTheme();
// A touch held still opens the context menu of what is under it, for every menu that opens on a right-click.
installLongPressContextMenu();
mount(App, '#root');
