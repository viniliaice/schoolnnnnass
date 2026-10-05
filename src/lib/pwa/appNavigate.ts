/** Navigate the in-app router from anywhere (deep links, history taps). */
import { requestNavigation } from './navigationBus';

export function navigateApp(path: string): void {
  requestNavigation(path);
}
