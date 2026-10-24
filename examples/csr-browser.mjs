// Bundle this module in the host's browser build. No Worker exports or secrets enter the bundle.
import { createEyeBrowser } from '@eye/workers/browser';
const checkout = { experimentId: 'checkout', variants: { standard: 'standard', compact: 'compact' }, fallback: 'standard' };

/** root is a host DOM container; scope/initial come from the authenticated host bootstrap.
 * One mount per application lifetime. navigate() is called by the router, not every render.
 */
export function mountCheckoutDemo(root, scope, initial) {
  const eye = createEyeBrowser({ scope, ...(initial ? { initial } : {}), onError: error => console.warn('Eye', error) });
  let view;
  const navigate = () => {
    view?.dispose();
    view = eye.beginView();
    const selection = view.variant(checkout);
    // No async work or automatic swap after background preparation completes.
    root.textContent = selection.value === 'compact' ? 'Compact checkout' : 'Standard checkout';
    // This example's container is the actual visible route, not a prefetch target.
    selection.expose();
  };
  const visibility = () => { if (document.visibilityState === 'hidden') void eye.flush(); };
  document.addEventListener('visibilitychange', visibility);
  navigate();
  return {
    navigate,
    authenticationChanged(nextScope) {
      // Call after authentication completes. A new view is an explicit safe application boundary.
      eye.setScope(nextScope); navigate();
    },
    async dispose() {
      view?.dispose(); document.removeEventListener('visibilitychange', visibility);
      await eye.flush(); eye.dispose();
    },
  };
}
