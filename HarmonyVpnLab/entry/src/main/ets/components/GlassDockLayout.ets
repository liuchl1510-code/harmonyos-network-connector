import { CommonModifier } from '@kit.ArkUI';
import { StatusBarScrim } from './StatusBarScrim';

@Component
export struct GlassDockLayout {
  @BuilderParam content: () => void = this.empty;
  @BuilderParam dock: () => void = this.empty;
  @Prop dockHeight: number = 84;
  @Prop showDock: boolean = true;
  private tabBarModifier: CommonModifier = new CommonModifier();

  aboutToAppear(): void { this.tabBarModifier.clip(false); }

  @Builder
  private empty() {}

  build() {
    Stack({ alignContent: Alignment.Top }) {
      if (this.showDock) {
        // One real page, not a second routing mechanism. The custom TabBar gives
        // systemMaterial its supported API 26 rendering context; its children
        // retain the existing Home/Nodes/Settings navigation and action callbacks.
        Tabs({ barPosition: BarPosition.End, barModifier: this.tabBarModifier }) {
          TabContent() { this.content(); }
            .clip(false).tabBar(this.dock);
        }.id('glassDockLayout').width('100%').height('100%')
          .vertical(false).scrollable(false).barMode(BarMode.Fixed)
          .barWidth('100%').barHeight(this.dockHeight)
          .barOverlap(true).barBackgroundColor(Color.Transparent)
          .barBackgroundBlurStyle(BlurStyle.NONE).divider(null)
          .animationDuration(0).clip(false);
      } else {
        this.content();
      }
      StatusBarScrim();
    }.width('100%').height('100%').clip(false);
  }
}
