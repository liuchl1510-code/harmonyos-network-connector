import { common } from '@kit.AbilityKit';
import { VPN_CORE_AVAILABLE } from '../model/BuildCapabilities';
import { readConnectionLifecycle } from '../model/ConnectionLifecycle';
import { dockActionForLifecycle, queueDockConnectionAction, cancelDockConnectionAction } from '../model/DockConnectionAction';
import { openMainTab } from '../model/MainNavigation';
import { DockMaterialState, DockGlassModifier, loadDockMaterial } from '../model/DockMaterial';

@Component
export struct DockPowerButton {
  current: string = 'home';
  @Prop requestInProgress: boolean = false;
  onConnectionAction: () => void = () => {};
  @State action: string = '';
  @State hint: string = '正在读取连接状态';
  @State navigating: boolean = false;
  @State material: DockMaterialState = new DockMaterialState();
  private poll: number = -1;
  private observedRunId: string = '';
  private mounted: boolean = false;

  private filesDir(): string {
    return (this.getUIContext().getHostContext() as common.UIAbilityContext).filesDir;
  }

  aboutToAppear(): void {
    this.mounted = true; this.refresh();
    void loadDockMaterial().then((material: DockMaterialState) => {
      if (this.mounted) { this.material = material; }
    });
  }
  aboutToDisappear(): void { this.mounted = false; this.stopPolling(); }

  private stopPolling(): void {
    if (this.poll >= 0) { clearInterval(this.poll); this.poll = -1; }
  }

  private setVisible(visible: boolean): void {
    if (!visible || !this.mounted) { this.stopPolling(); return; }
    this.refresh();
    if (this.poll < 0 && VPN_CORE_AVAILABLE) { this.poll = setInterval(() => this.refresh(), 1000); }
  }

  private refresh(): void {
    if (!VPN_CORE_AVAILABLE) { this.action = ''; this.hint = '界面预览版本不提供 VPN 连接'; return; }
    try {
      const state = readConnectionLifecycle(this.filesDir());
      this.observedRunId = state.state.runId;
      this.action = dockActionForLifecycle(state, VPN_CORE_AVAILABLE);
      this.hint = this.action === 'connect' ? '使用当前节点和网络设置连接' :
        this.action === 'disconnect' ? '结束当前 VPN 连接' :
        state.phase === 'stopping' ? '正在断开，请等待清理完成' :
        state.phase === 'diagnostic' || state.state.kind !== 'connection' && !state.closed ?
          '检测正在运行，请等待结束' : '请在连接页面确认当前状态';
    } catch (_) { this.action = ''; this.hint = '暂时无法读取连接状态'; }
  }

  private async activate(): Promise<void> {
    if (!this.mounted || this.navigating || this.requestInProgress || !VPN_CORE_AVAILABLE) { return; }
    this.navigating = true;
    let sequence = -1;
    try {
      const request = queueDockConnectionAction(this.filesDir(), VPN_CORE_AVAILABLE, this.action, this.observedRunId);
      if (!request) { return; }
      sequence = request.sequence;
      if (this.current === 'home') { this.onConnectionAction(); }
      else if (!await openMainTab(this.getUIContext(), this.current, 'home')) {
        cancelDockConnectionAction(sequence);
      }
    } catch (_) {
      if (sequence >= 0) { cancelDockConnectionAction(sequence); }
    } finally { if (this.mounted) { this.navigating = false; this.refresh(); } }
  }

  build() {
    Button({ type: ButtonType.Circle }) {
      Image(this.action === 'disconnect' ? $r('app.media.ic_stop') : $r('app.media.ic_play'))
        .width(26).height(26)
        .fillColor(this.action.length > 0 ? $r('app.color.accent') : $r('app.color.text_secondary'));
    }.id('dockConnectionAction').width(64).height(64).flexShrink(0)
      .borderRadius(32).attributeModifier(new DockGlassModifier(this.material.action))
      .enabled(this.action.length > 0 && !this.navigating && !this.requestInProgress)
      .accessibilityText(this.requestInProgress ? '正在准备连接' : this.action === 'disconnect' ? '断开连接' : '连接 VPN')
      .accessibilityDescription(this.hint)
      .onClick(() => { void this.activate(); })
      .onVisibleAreaChange([0.0], (visible: boolean, ratio: number) => { this.setVisible(visible && ratio > 0); });
  }
}
