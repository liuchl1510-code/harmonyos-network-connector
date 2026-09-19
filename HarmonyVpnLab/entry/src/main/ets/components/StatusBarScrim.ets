@Component
export struct StatusBarScrim {
  @StorageProp('statusBarHeightVp') statusBarHeightVp: number = 0;

  build() {
    if (Number.isFinite(this.statusBarHeightVp) && this.statusBarHeightVp > 0) {
      // Position relative to the safe-layout origin: cover the system clock
      // area above it, then fade over the first 20 vp of scrolled page content.
      Column() {}
        .id('statusBarScrim').width('100%').height(this.statusBarHeightVp + 20)
        .position({ x: 0, y: -this.statusBarHeightVp })
        .linearGradient({ direction: GradientDirection.Bottom, colors: [
          [$r('app.color.status_bar_tint'), 0],
          [$r('app.color.status_bar_tint'), this.statusBarHeightVp / (this.statusBarHeightVp + 20)],
          [$r('app.color.status_bar_clear'), 1]
        ] })
        .hitTestBehavior(HitTestMode.None).focusable(false)
        .accessibilityLevel('no-hide-descendants');
    }
  }
}
