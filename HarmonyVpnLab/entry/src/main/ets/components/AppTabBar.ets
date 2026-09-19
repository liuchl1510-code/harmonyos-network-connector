import { openMainTab } from '../model/MainNavigation';
import { DockPowerButton } from './DockPowerButton';
import { DockMaterialState, DockGlassModifier, loadDockMaterial } from '../model/DockMaterial';

@Component
export struct AppTabBar {
  current: string = 'home';
  @Prop requestInProgress: boolean = false;
  onConnectionAction: () => void = () => {};
  @State material: DockMaterialState = new DockMaterialState();
  private mounted: boolean = false;

  aboutToAppear(): void {
    this.mounted = true;
    void loadDockMaterial().then((material: DockMaterialState) => {
      if (this.mounted) { this.material = material; }
    });
  }

  aboutToDisappear(): void { this.mounted = false; }

  build() {
    Row({ space: 10 }) {
      Row({ space: 2 }) {
        this.item('home', '连接', $r('app.media.ic_power'), 'navHome');
        this.item('nodes', '节点', $r('app.media.ic_nodes'), 'navNodes');
        this.item('settings', '设置', $r('app.media.ic_settings'), 'navSettings');
      }.id('floatingNavigationCapsule').layoutWeight(1).constraintSize({ minHeight: 64 })
        .padding(5).borderRadius(40).attributeModifier(new DockGlassModifier(this.material.capsule));
      DockPowerButton({ current: this.current, requestInProgress: this.requestInProgress,
        onConnectionAction: this.onConnectionAction });
    }.id('floatingNavigationDock').width('100%').constraintSize({ maxWidth: 560 })
      .padding({ top: 10, bottom: 8, left: 12, right: 12 }).hitTestBehavior(HitTestMode.Transparent);
  }

  @Builder
  item(target: string, label: string, icon: Resource, controlId: string) {
    Button({ type: ButtonType.Normal }) {
      Column({ space: 3 }) {
        Image(icon).width(22).height(22)
          .fillColor(this.current === target ? $r('app.color.accent') : $r('app.color.text_secondary'));
        Text(label).fontSize(12).fontWeight(this.current === target ? FontWeight.Medium : FontWeight.Regular)
          .maxLines(1)
          .fontColor(this.current === target ? $r('app.color.accent') : $r('app.color.text_secondary'));
      }.width('100%').padding({ top: 6, bottom: 6 });
    }.id(controlId).layoutWeight(1).constraintSize({ minHeight: 52 })
      .backgroundColor(this.current === target ? $r('app.color.dock_glass_selected') : Color.Transparent).borderRadius(30)
      .accessibilityText(label).accessibilityDescription(this.current === target ? '当前页面' : '切换到' + label)
      .onClick(() => { void openMainTab(this.getUIContext(), this.current, target); });
  }
}
