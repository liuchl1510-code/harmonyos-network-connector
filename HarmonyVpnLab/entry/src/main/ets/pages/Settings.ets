import { common } from '@kit.AbilityKit';
import { AppTabBar } from '../components/AppTabBar';
import { GlassDockLayout } from '../components/GlassDockLayout';
import { AppSideNav } from '../components/AppSideNav';
import { applyAppearance, readAppearance, saveAppearance } from '../model/Appearance';
import { formContentWidth, useSideNavigation } from '../model/AdaptiveLayout';
import { VPN_CORE_AVAILABLE } from '../model/BuildCapabilities';

@Entry
@Component
struct Settings {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State dockHeight: number = 84;
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
    if (!VPN_CORE_AVAILABLE) { this.message = '当前为界面预览构建，开发验证暂不可用。'; return; }
    AppStorage.setOrCreate('openDeveloperTools', true);
    this.getUIContext().getRouter().back();
  }

  build() {
    Row() {
      if (useSideNavigation(this.windowWidthVp)) {
        AppSideNav({ current: 'settings' });
      }
      GlassDockLayout({ showDock: !useSideNavigation(this.windowWidthVp), dockHeight: this.dockHeight,
        content: () => { this.pageContent(); }, dock: () => { this.navigationDock(); }
      }).layoutWeight(1).height('100%');
    }.width('100%').height('100%').background($r('app.color.page_bg'));
  }

  @Builder
  private pageContent() {
        Scroll() {
          Column({ space: 24 }) {
            Column({ space: 6 }) {
              Text('设置').id('settingsTitle').fontSize(30).fontWeight(FontWeight.Bold)
                .fontColor($r('app.color.text_primary'));
              Text('按你的习惯使用 Harmony VPN').fontSize(14).fontColor($r('app.color.text_secondary'));
            }.width('100%').alignItems(HorizontalAlign.Start);

            Column({ space: 16 }) {
              Text('外观').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
              Flex({ direction: FlexDirection.Row, alignItems: ItemAlign.Stretch }) {
                this.appearanceOption('system', '跟随系统', $r('app.media.ic_theme_system'));
                this.appearanceOption('light', '浅色', $r('app.media.ic_theme_light'));
                this.appearanceOption('dark', '深色', $r('app.media.ic_theme_dark'));
              }.width('100%');
              Text('跟随系统会自动适应设备的浅色与深色模式。').fontSize(13)
                .fontColor($r('app.color.text_secondary')).lineHeight('21fp');
            }.padding(20).width('100%').alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20);

            Column({ space: 2 }) {
              Text('连接与数据').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_secondary'))
                .padding({ left: 18, right: 18, top: 14, bottom: 4 });
              this.navigationRow('网络设置', '应用范围、分流规则与 HTTPS DNS', 'openNetworkSettings', 'NetworkSettings');
              Divider().color($r('app.color.border')).margin({ left: 18, right: 18 });
              this.navigationRow('节点备份与恢复', '导出节点与订阅，或从文件恢复', 'openNodeBackup', 'NodeBackup');
            }.width('100%').padding({ top: 4, bottom: 4 }).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20);

            Column({ space: 2 }) {
              Text('帮助与说明').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_secondary'))
                .padding({ left: 18, right: 18, top: 14, bottom: 4 });
              this.navigationRow('连接诊断', '查看连接、网络恢复与检测记录', 'openSettingsDiagnostics', 'Diagnostics');
              Divider().color($r('app.color.border')).margin({ left: 18, right: 18 });
              this.navigationRow('关于', '版本与开源组件', 'openAbout', 'About');
              Divider().color($r('app.color.border')).margin({ left: 18, right: 18 });
              this.navigationRow('隐私说明', '了解本地保存与联网行为', 'openPrivacy', 'Privacy');
            }.width('100%').padding({ top: 4, bottom: 4 }).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20);

            Button({ type: ButtonType.Normal }) {
              Row({ space: 12 }) {
                Column({ space: 5 }) {
                  Text('开发工具').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_secondary'));
                  Text(VPN_CORE_AVAILABLE ? '短时验证与网络检查' : '界面预览构建暂不可用').fontSize(12).fontColor($r('app.color.text_secondary'));
                }.layoutWeight(1).alignItems(HorizontalAlign.Start);
                Text('›').fontSize(22).fontColor($r('app.color.text_secondary'));
              }.width('100%').padding({ left: 4, right: 4, top: 8, bottom: 8 });
            }.id('openDeveloperTools').width('100%').backgroundColor(Color.Transparent)
              .borderRadius(12).enabled(VPN_CORE_AVAILABLE).onClick(() => { this.openDeveloperTools(); });

            if (this.message.length > 0) {
              Text(this.message).id('settingsResult').fontSize(14).lineHeight('22fp')
                .fontColor($r('app.color.text_secondary')).width('100%');
            }
          }.width(formContentWidth(this.windowWidthVp))
            .padding({ left: 24, right: 24, top: 16, bottom: useSideNavigation(this.windowWidthVp) ? 28 : this.dockHeight + 28 })
            .alignItems(HorizontalAlign.Start);
        }.id('settingsScroll').width('100%').height('100%').align(Alignment.Top)
          .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]);
  }

  @Builder
  private navigationDock() {
          AppTabBar({ current: 'settings' })
            .onAreaChange((_oldArea: Area, area: Area) => { this.dockHeight = Number(area.height); });
  }

  @Builder
  private appearanceOption(mode: string, label: string, icon: Resource) {
    Button({ type: ButtonType.Normal }) {
      Column({ space: 8 }) {
        Row({ space: 6 }) {
          Image(icon).width(24).height(24).objectFit(ImageFit.Contain)
            .fillColor(this.appearance === mode ? $r('app.color.accent') : $r('app.color.text_secondary'));
          if (this.appearance === mode) {
            Text('✓').fontSize(14).fontColor($r('app.color.accent'));
          }
        }.width('100%').justifyContent(FlexAlign.Center);
        Text(label).fontSize(14).constraintSize({ minHeight: '32fp' }).width('100%').textAlign(TextAlign.Center)
          .fontWeight(this.appearance === mode ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(this.appearance === mode ? $r('app.color.accent') : $r('app.color.text_secondary'));
      }.padding({ top: 12, bottom: 12, left: 6, right: 6 }).width('100%')
        .constraintSize({ minHeight: 88 }).justifyContent(FlexAlign.Center);
    }.id(`appearance-${mode}`).layoutWeight(1).padding(0).constraintSize({ minHeight: 88 })
      .margin({ left: 4, right: 4 })
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
