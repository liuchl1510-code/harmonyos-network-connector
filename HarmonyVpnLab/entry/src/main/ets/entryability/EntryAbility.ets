import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import native from 'libvpnbridge.so';
import { applyAppearance, readAppearance } from '../model/Appearance';
import { normalizedWindowWidth } from '../model/AdaptiveLayout';
import { VPN_CORE_AVAILABLE } from '../model/BuildCapabilities';
import { deviceInfo } from '@kit.BasicServicesKit';

interface SmokeResult {
  passed: boolean;
  workers?: number;
  completedCalls?: number;
  registerFailureMask?: number;
  replyFailures?: number;
}

export default class EntryAbility extends UIAbility {
  private runtimeMode: string = '';
  private contentReady: boolean = false;
  private uiFontScaleTest: number = 0;
  private mainWindow?: window.Window;
  private resizeListener?: (size: window.Size) => void;
  private avoidAreaListener?: (options: window.AvoidAreaOptions) => void;
  private windowSizeTest: string = '';

  onCreate(want: Want): void {
    AppStorage.setOrCreate('windowWidthVp', 360);
    AppStorage.setOrCreate('statusBarHeightVp', 0);
    this.readUiFontTest(want);
    const mode = want.parameters?.['runtimeSmoke'];
    if (mode === 'fixtures' || mode === 'go') {
      // Debug-only command, run in a fresh UI process. The Xray VPN extension
      // owns its separate process; this one never loads the production Go core.
      this.runtimeMode = mode === 'go' ? 'go' : 'fixtures';
      AppStorage.setOrCreate('runtimeSmokeStatus', '正在检查');
      AppStorage.setOrCreate('runtimeSmokeDetail', this.runtimeMode === 'go' ? 'Go 运行时并发与内存检查' : '原生正向和故障样例检查');
      AppStorage.setOrCreate('runtimeSmokeFinished', false);
      this.runRuntimeChecks(this.runtimeMode);
    }
  }

  onNewWant(want: Want): void {
    this.readUiFontTest(want);
    if (this.contentReady) { this.applyUiFontTest(); }
  }

  private readUiFontTest(want: Want): void {
    const scale = want.parameters?.['uiFontScale'];
    if (this.context.applicationInfo.debug && typeof scale === 'string' && ['1', '1.3', '2'].includes(scale)) {
      this.uiFontScaleTest = Number(scale);
    }
    const size = want.parameters?.['uiWindowSize'];
    if (this.context.applicationInfo.debug && typeof size === 'string' && /^[0-9]{3,4}x[0-9]{3,4}$/.test(size)) {
      this.windowSizeTest = size;
    }
  }

  private applyUiFontTest(): void {
    // Debug-package-only visual QA. This is process-local and does not change
    // system preferences or write a user preference; a fresh launch resets it.
    if (this.context.applicationInfo.debug && this.uiFontScaleTest > 0) {
      this.context.getApplicationContext().setFontSizeScale(this.uiFontScaleTest);
      hilog.info(0x0000, 'HarmonyVpnLab', 'UI_FONT_SCALE_TEST scale=%{public}s', this.uiFontScaleTest.toString());
    }
    if (this.context.applicationInfo.debug && this.mainWindow && this.windowSizeTest && deviceInfo.deviceType === '2in1') {
      const dimensions = this.windowSizeTest.split('x').map((value: string) => Number(value));
      this.windowSizeTest = '';
      if (dimensions[0] >= 320 && dimensions[0] <= 1600 && dimensions[1] >= 320 && dimensions[1] <= 1200) {
        const ui = this.mainWindow.getUIContext();
        // Debug-only QA of this app's PC window; never change display/system settings.
        void this.mainWindow.resizeAsync(Math.round(ui.vp2px(dimensions[0])), Math.round(ui.vp2px(dimensions[1])))
          .then(() => { hilog.info(0x0000, 'HarmonyVpnLab', 'UI_WINDOW_RESIZE_TEST width=%{public}d height=%{public}d', dimensions[0], dimensions[1]); })
          .catch(() => { hilog.warn(0x0000, 'HarmonyVpnLab', 'UI_WINDOW_RESIZE_TEST_UNAVAILABLE'); });
      }
    }
  }

  private async runRuntimeChecks(mode: string): Promise<void> {
    if (!VPN_CORE_AVAILABLE) {
      AppStorage.set('runtimeSmokeStatus', '仅界面预览');
      AppStorage.set('runtimeSmokeDetail', '此模拟器构建不包含原生转发与运行时探针。');
      AppStorage.set('runtimeSmokeFinished', true);
      return;
    }
    const runId = Date.now().toString();
    hilog.info(0x0000, 'HarmonyVpnLab', 'RUNTIME_SMOKE_BEGIN runId=%{public}s mode=%{public}s', runId, mode);
    try {
      const kinds: string[] = mode === 'fixtures' ? ['good', 'broken'] : ['go'];
      let valid: boolean = true;
      for (const kind of kinds) {
        const text = await native.runRuntimeSmoke(kind);
        const result = JSON.parse(text) as SmokeResult;
        hilog.info(0x0000, 'HarmonyVpnLab', 'RUNTIME_SMOKE_RESULT runId=%{public}s kind=%{public}s result=%{public}s', runId, kind, text);
        const counts = result.workers === 4 && result.completedCalls === 32 && result.replyFailures === 0;
        valid = valid && counts && (kind === 'broken'
          ? result.passed === false && result.registerFailureMask === 64
          : result.passed === true && result.registerFailureMask === 0);
      }
      hilog.info(0x0000, 'HarmonyVpnLab', 'RUNTIME_SMOKE_VERDICT runId=%{public}s mode=%{public}s passed=%{public}s', runId, mode, valid.toString());
      AppStorage.set('runtimeSmokeStatus', valid ? '检查通过' : '检查未通过');
      AppStorage.set('runtimeSmokeDetail', valid ? '线程调用、返回结果与寄存器保存均符合本次预期。' : '详细结果已写入调试日志。');
    } catch (_) {
      hilog.error(0x0000, 'HarmonyVpnLab', 'RUNTIME_SMOKE_ERROR runId=%{public}s mode=%{public}s', runId, mode);
      AppStorage.set('runtimeSmokeStatus', '检查未完成');
      AppStorage.set('runtimeSmokeDetail', '详细结果已写入调试日志。');
    } finally {
      AppStorage.set('runtimeSmokeFinished', true);
    }
  }
  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.mainWindow = windowStage.getMainWindowSync();
    // The diagnostic page never loads Index.refreshState, which could resume
    // an earlier HTTP test and interfere with this isolated runtime check.
    const page: string = this.runtimeMode.length > 0 ? 'pages/RuntimeSmoke' : 'pages/Home';
    windowStage.loadContent(page, (err) => {
      if (err.code) {
        hilog.error(0x0000, 'HarmonyVpnLab', 'UI_LOAD_FAILED %{public}s', JSON.stringify(err));
        return;
      }
      this.contentReady = true;
      this.attachWindowSize();
      this.attachStatusBarHeight();
      try { applyAppearance(this.context, readAppearance(this.context.filesDir)); this.applyUiFontTest(); }
      catch (_) { hilog.warn(0x0000, 'HarmonyVpnLab', 'APPEARANCE_APPLY_FAILED'); }
      hilog.info(0x0000, 'HarmonyVpnLab', 'UI_READY');
    });
  }

  private attachWindowSize(): void {
    const main = this.mainWindow;
    if (!main || this.resizeListener) { return; }
    const update = (size: window.Size): void => {
      try {
        const width = normalizedWindowWidth(main.getUIContext().px2vp(size.width));
        AppStorage.setOrCreate('windowWidthVp', Math.round(width * 10) / 10);
      } catch (_) { /* Retain the last valid window width during destruction. */ }
      this.updateStatusBarHeight(main);
    };
    try {
      const rect = main.getWindowProperties().windowRect;
      update({ width: rect.width, height: rect.height });
      main.on('windowSizeChange', update);
      this.resizeListener = update;
    } catch (_) { hilog.warn(0x0000, 'HarmonyVpnLab', 'WINDOW_SIZE_LISTENER_UNAVAILABLE'); }
  }

  private updateStatusBarHeight(main: window.Window, area?: window.AvoidArea): void {
    if (this.mainWindow !== main) { return; }
    if (deviceInfo.deviceType === '2in1' || deviceInfo.deviceType === 'pc') {
      AppStorage.setOrCreate('statusBarHeightVp', 0); return;
    }
    try {
      const current = area ?? main.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const pixels = current.topRect.height;
      if (!Number.isFinite(pixels) || pixels < 0) { return; }
      const height = main.getUIContext().px2vp(pixels);
      if (!Number.isFinite(height) || height < 0) { return; }
      AppStorage.setOrCreate('statusBarHeightVp', Math.round(height * 10) / 10);
    } catch (_) { /* Retain the last measured inset if the window is not ready. */ }
  }

  private attachStatusBarHeight(): void {
    const main = this.mainWindow;
    if (!main) { return; }
    this.updateStatusBarHeight(main);
    if (this.avoidAreaListener || deviceInfo.deviceType === '2in1' || deviceInfo.deviceType === 'pc') { return; }
    const update = (options: window.AvoidAreaOptions): void => {
      if (options.type === window.AvoidAreaType.TYPE_SYSTEM) { this.updateStatusBarHeight(main, options.area); }
    };
    try {
      main.on('avoidAreaChange', update);
      this.avoidAreaListener = update;
    } catch (_) { hilog.warn(0x0000, 'HarmonyVpnLab', 'WINDOW_AVOID_AREA_LISTENER_UNAVAILABLE'); }
  }

  onWindowStageDestroy(): void {
    try { if (this.mainWindow && this.resizeListener) { this.mainWindow.off('windowSizeChange', this.resizeListener); } }
    catch (_) { /* The platform may already have destroyed the window. */ }
    try { if (this.mainWindow && this.avoidAreaListener) { this.mainWindow.off('avoidAreaChange', this.avoidAreaListener); } }
    catch (_) { /* Remove the independent listener even if resize cleanup failed. */ }
    this.resizeListener = undefined; this.avoidAreaListener = undefined; this.mainWindow = undefined; this.contentReady = false;
    AppStorage.setOrCreate('statusBarHeightVp', 0);
  }
}
