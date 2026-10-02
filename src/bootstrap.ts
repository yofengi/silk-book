import { failStartup } from './core/startup';

// Catch module loading/evaluation failures as well as async frontend initialization errors.
void import('./main').then(({ start }) => start()).catch(failStartup);
