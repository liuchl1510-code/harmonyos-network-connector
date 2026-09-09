import { openMainTab } from '../model/MainNavigation';

@Component
export struct AppSideNav {
  current: string = 'home';

  build() {
    Scroll() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Image($r('app.media.ic_shield')).width(24).height(24).fillColor($r('app.color.accent'));
        Text('Harmony VPN').fontSize(16).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
          .layoutWeight(1).maxLines(2);
      }.width('100%').padding({ top: 16, bottom: 24, left: 4, right: 4 });
      this.item('home', '连接', $r('app.media.ic_power'), 'navHome');
      this.item('nodes', '节点', $r('app.media.ic_nodes'), 'navNodes');
      this.item('settings', '设置', $r('app.media.ic_settings'), 'navSettings');
    }.width('100%').padding({ left: 12, right: 12, top: 12, bottom: 16 });
    }.id('appSideNavigation').width(176).height('100%').align(Alignment.Top).scrollBar(BarState.Off)
      .backgroundColor($r('app.color.surface')).border({ width: { right: 0.5 }, color: $r('app.color.border') });
  }

  @Builder
  private item(target: string, label: string, icon: Resource, controlId: string) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Image(icon).width(24).height(24)
          .fillColor(this.current === target ? $r('app.color.accent') : $r('app.color.text_secondary'));
        Text(label).fontSize(16).fontWeight(this.current === target ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(this.current === target ? $r('app.color.accent') : $r('app.color.text_secondary'));
      }.width('100%').padding({ top: 14, bottom: 14, left: 12, right: 12 });
    }.id(controlId).width('100%').constraintSize({ minHeight: 52 })
      .backgroundColor(this.current === target ? $r('app.color.accent_soft') : Color.Transparent).borderRadius(14)
      .hoverEffect(HoverEffect.Auto).accessibilityText(label)
      .accessibilityDescription(this.current === target ? '当前页面' : '切换到' + label)
      .onClick(() => { void openMainTab(this.getUIContext(), this.current, target); });
  }
}
