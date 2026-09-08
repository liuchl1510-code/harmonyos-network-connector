import { common } from '@kit.AbilityKit';
import { AppTabBar } from '../components/AppTabBar';
import { applyAppearance, readAppearance, saveAppearance } from '../model/Appearance';

@Entry
@Component
struct Settings {
  @State appearance: string = 'system';
  @State message: string = '';

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  aboutToAppear(): void { this.appearance = readAppearance(this.context().filesDir); }
  onPageShow(): void { this.appearance = readAppearance(this.context().filesDir); }

  private chooseAppearance(mode: string): void {
    if (mode === this.appearance) { return; }
    const previous = this.appearance;
    const context = this.context();
    try { applyAppearance(context, mode); }
    catch (_) { this.message = '外观暂时无法切换，请重试。'; return; }
    try {
      saveAppearance(context.filesDir, mode);
      this.appearance = mode;
      this.message = '外观设置已保存。';
    } catch (_) {
      try {
        applyAppearance(context, previous);
        this.message = '设置未保存，已恢复原外观，请重试。';
      } catch (_) { this.message = '设置未保存，重新打开应用后将使用原外观。'; }
    }
  }

  private openPage(page: string): void {
    this.getUIContext().getRouter().pushUrl({ url: `pages/${page}` })
      .catch(() => { this.message = '页面暂时无法打开，请重试。'; });
  }

  private openDeveloperTools(): void {
    AppStorage.setOrCreate('openDeveloperTools', true);
    this.getUIContext().getRouter().back();
  }

  build() {
    Column() {
      Scroll() {
        Column({ space: 24 }) {
          Column({ space: 6 }) {
            Text('设置').id('settingsTitle').fontSize(30).fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'));
            Text('按你的习惯使用 Harmony VPN').fontSize(14).fontColor($r('app.color.text_secondary'));
          }.width('100%').alignItems(HorizontalAlign.Start);

          Column({ space: 16 }) {
            Text('外观').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Row({ space: 8 }) {
              this.appearanceOption('system', '跟随系统', $r('app.media.ic_theme_system'));
              this.appearanceOption('light', '浅色', $r('app.media.ic_theme_light'));
              this.appearanceOption('dark', '深色', $r('app.media.ic_theme_dark'));
            }.width('100%');
            Text('跟随系统会自动适应设备的浅色与深色模式。').fontSize(13)
              .fontColor($r('app.color.text_secondary')).lineHeight('21fp');
          }.padding(20).width('100%').alignItems(HorizontalAlign.Start)
            .backgroundColor($r('app.color.surface')).borderRadius(20);

          Column({ space: 2 }) {
            this.navigationRow('连接诊断', '查看连接、网络恢复与检测记录', 'openSettingsDiagnostics', 'Diagnostics');
            Divider().color($r('app.color.border')).margin({ left: 18, right: 18 });
            this.navigationRow('关于', '版本与开源组件', 'openAbout', 'About');
            Divider().color($r('app.color.border')).margin({ left: 18, right: 18 });
            this.navigationRow('隐私说明', '了解本地保存与联网行为', 'openPrivacy', 'Privacy');
          }.width('100%').padding({ top: 4, bottom: 4 })
            .backgroundColor($r('app.color.surface')).borderRadius(20);

          Button({ type: ButtonType.Normal }) {
            Row({ space: 12 }) {
              Column({ space: 5 }) {
                Text('开发工具').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
                Text('短时验证与网络检查').fontSize(13).fontColor($r('app.color.text_secondary'));
              }.layoutWeight(1).alignItems(HorizontalAlign.Start);
              Text('›').fontSize(26).fontColor($r('app.color.text_secondary'));
            }.width('100%').padding(18);
          }.id('openDeveloperTools').width('100%').backgroundColor($r('app.color.surface'))
            .borderRadius(20).onClick(() => { this.openDeveloperTools(); });

          if (this.message.length > 0) {
            Text(this.message).id('settingsResult').fontSize(14).lineHeight('22fp')
              .fontColor($r('app.color.text_secondary')).width('100%');
          }
        }.width('100%').padding({ left: 24, right: 24, top: 24, bottom: 28 }).alignItems(HorizontalAlign.Start);
      }.layoutWeight(1).width('100%').align(Alignment.Top);
      AppTabBar({ current: 'settings' });
    }.width('100%').height('100%').backgroundColor($r('app.color.page_bg'));
  }

  @Builder
  private appearanceOption(mode: string, label: string, icon: Resource) {
    Button({ type: ButtonType.Normal }) {
      Column({ space: 9 }) {
        Image(icon).width(28).height(28).objectFit(ImageFit.Contain)
          .fillColor(this.appearance === mode ? $r('app.color.accent') : $r('app.color.text_secondary'));
        Text(label).fontSize(14).height('32fp').width('100%').maxLines(2).textAlign(TextAlign.Center)
          .fontWeight(this.appearance === mode ? FontWeight.Medium : FontWeight.Regular)
          .width('100%').textAlign(TextAlign.Center)
          .fontColor(this.appearance === mode ? $r('app.color.accent') : $r('app.color.text_secondary'));
        Text(this.appearance === mode ? '已选择' : '选择').fontSize(11)
          .width('100%').textAlign(TextAlign.Center)
          .fontColor(this.appearance === mode ? $r('app.color.accent') : $r('app.color.text_secondary'));
      }.padding({ top: 16, bottom: 16, left: 6, right: 6 }).width('100%')
        .constraintSize({ minHeight: 124 }).justifyContent(FlexAlign.Center);
    }.id(`appearance-${mode}`).layoutWeight(1).padding(0).constraintSize({ minHeight: 124 })
      .backgroundColor(this.appearance === mode ? $r('app.color.accent_soft') : $r('app.color.surface_secondary'))
      .border({ width: 1, color: this.appearance === mode ? $r('app.color.accent') : $r('app.color.border') })
      .borderRadius(14).clip(true)
      .accessibilityText(`${label}，${this.appearance === mode ? '已选择' : '未选择'}`)
      .onClick(() => { this.chooseAppearance(mode); });
  }

  @Builder
  private navigationRow(title: string, subtitle: string, id: string, page: string) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Column({ space: 5 }) {
          Text(title).fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
          Text(subtitle).fontSize(13).fontColor($r('app.color.text_secondary')).lineHeight('20fp');
        }.layoutWeight(1).alignItems(HorizontalAlign.Start);
        Text('›').fontSize(26).fontColor($r('app.color.text_secondary'));
      }.width('100%').padding(18);
    }.id(id).width('100%').backgroundColor(Color.Transparent).borderRadius(14)
      .onClick(() => { this.openPage(page); });
  }
}
