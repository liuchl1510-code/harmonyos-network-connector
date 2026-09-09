import { vpnExtension } from '@kit.NetworkKit';
import { deviceInfo } from '@kit.BasicServicesKit';

type AuthorizationListener = (allowed: boolean) => void;

// Keep one native observer strongly reachable for the UI process lifetime.
// On HarmonyOS 7.0.0.105, collecting an old observer after creating a new one
// blocked the UI in CreateVpnObserver's finalizer / DeleteAllListener.
// Pages own only ArkTS subscriptions; hiding or releasing a page must not
// finalize the SDK object or unregister another page's native callback.
let observer: vpnExtension.VpnObserver | undefined = undefined;
let registered: boolean = false;
let nextSubscription: number = 0;
const listeners: Map<number, AuthorizationListener> = new Map();

export function subscribeVpnAuthorization(listener: AuthorizationListener): number {
  // Authorization observers were introduced in API 26. Older systems still
  // support starting the VPN; callers reconcile the service state and timeout.
  if (deviceInfo.sdkApiVersion < 26 || typeof vpnExtension.createVpnObserver !== 'function') { return -1; }
  if (!observer) { observer = vpnExtension.createVpnObserver(); }
  if (!registered) {
    observer.onAuthorizationResult((allowed: boolean) => {
      listeners.forEach((callback: AuthorizationListener) => { callback(allowed); });
    });
    registered = true;
  }
  const subscription = ++nextSubscription;
  listeners.set(subscription, listener);
  return subscription;
}

export function unsubscribeVpnAuthorization(subscription: number): void {
  listeners.delete(subscription);
}
