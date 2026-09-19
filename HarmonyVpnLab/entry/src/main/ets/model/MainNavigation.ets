import { UIContext } from '@kit.ArkUI';

let navigationPending: boolean = false;

// Home remains at the bottom of the route stack, retaining the single VPN
// authorization subscription while Nodes and Settings replace one another.
export async function openMainTab(context: UIContext, current: string, target: string): Promise<boolean> {
  if (current === target || navigationPending || !['home', 'nodes', 'settings'].includes(current) ||
    !['home', 'nodes', 'settings'].includes(target)) { return false; }
  navigationPending = true;
  try {
    const router = context.getRouter();
    if (target === 'home') {
      router.back();
      // back() is synchronous; retain the latch while its old tab is removed.
      await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
    }
    else {
      const url = target === 'nodes' ? 'pages/Nodes' : 'pages/Settings';
      if (current === 'home') { await router.pushUrl({ url }); }
      else { await router.replaceUrl({ url }); }
    }
    return true;
  } catch (_) {
    try { context.getPromptAction().showToast({ message: '页面暂未打开，请重试。' }); } catch (_) {}
    return false;
  } finally { navigationPending = false; }
}
