type CheckoutListener = () => void | Promise<void>;

const checkoutListeners = new Set<CheckoutListener>();

/**
 * Visit navigation is a foreground concern, but checkout can be completed by
 * the attendance screen, the offline queue, or background geofence handling.
 * This tiny in-process signal lets every successful checkout stop the active
 * navigator immediately without coupling attendance code to React context.
 */
export function subscribeToVisitNavigationCheckout(listener: CheckoutListener): () => void {
  checkoutListeners.add(listener);
  return () => checkoutListeners.delete(listener);
}

export function notifyVisitNavigationCheckout(): void {
  for (const listener of checkoutListeners) {
    Promise.resolve(listener()).catch(() => undefined);
  }
}
