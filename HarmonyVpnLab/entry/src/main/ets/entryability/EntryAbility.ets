import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import native from 'libvpnbridge.so';
import { applyAppearance, readAppearance } from '../model/Appearance';

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

  onCreate(want: Want): void {
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
  }

  private applyUiFontTest(): void {
    // Debug-package-only visual QA. This is process-local and does not change
    // system preferences or write a user preference; a fresh launch resets it.
    if (this.context.applicationInfo.debug && this.uiFontScaleTest > 0) {
      this.context.getApplicationContext().setFontSizeScale(this.uiFontScaleTest);
      hilog.info(0x0000, 'HarmonyVpnLab', 'UI_FONT_SCALE_TEST scale=%{public}s', this.uiFontScaleTest.toString());
    }
  }

  private async runRuntimeChecks(mode: string): Promise<void> {
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
    // The diagnostic page never loads Index.refreshState, which could resume
    // an earlier HTTP test and interfere with this isolated runtime check.
    const page: string = this.runtimeMode.length > 0 ? 'pages/RuntimeSmoke' : 'pages/Home';
    windowStage.loadContent(page, (err) => {
      if (err.code) {
        hilog.error(0x0000, 'HarmonyVpnLab', 'UI_LOAD_FAILED %{public}s', JSON.stringify(err));
        return;
      }
      this.contentReady = true;
      try { applyAppearance(this.context, readAppearance(this.context.filesDir)); this.applyUiFontTest(); }
      catch (_) { hilog.warn(0x0000, 'HarmonyVpnLab', 'APPEARANCE_APPLY_FAILED'); }
      hilog.info(0x0000, 'HarmonyVpnLab', 'UI_READY');
    });
  }
}
