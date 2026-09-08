import { openMainTab } from '../model/MainNavigation';

@Component
export struct AppTabBar {
  current: string = 'home';

  build() {
    Row() {
      this.item('home', '连接', $r('app.media.ic_power'), 'navHome');
      this.item('nodes', '节点', $r('app.media.ic_nodes'), 'navNodes');
      this.item('settings', '设置', $r('app.media.ic_settings'), 'navSettings');
    }.width('100%').padding({ top: 8, bottom: 8, left: 16, right: 16 })
      .backgroundColor($r('app.color.surface')).border({ width: { top: 0.5 }, color: $r('app.color.border') });
  }

  @Builder
  item(target: string, label: string, icon: Resource, controlId: string) {
    Button({ type: ButtonType.Normal }) {
      Column({ space: 4 }) {
        Image(icon).width(24).height(24)
          .fillColor(this.current === target ? $r('app.color.accent') : $r('app.color.text_secondary'));
        Text(label).fontSize(12).fontWeight(this.current === target ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(this.current === target ? $r('app.color.accent') : $r('app.color.text_secondary'));
      }.width('100%').padding({ top: 5, bottom: 5 });
    }.id(controlId).layoutWeight(1).backgroundColor(Color.Transparent).borderRadius(16)
      .accessibilityText(label).accessibilityDescription(this.current === target ? '当前页面' : '切换到' + label)
      .onClick(() => { void openMainTab(this.getUIContext(), this.current, target); });
  }
}
