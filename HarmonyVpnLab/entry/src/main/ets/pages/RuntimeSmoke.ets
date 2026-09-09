import { formContentWidth } from '../model/AdaptiveLayout';

@Entry
@Component
struct RuntimeSmoke {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @StorageLink('runtimeSmokeStatus') status: string = '等待开始';
  @StorageLink('runtimeSmokeDetail') detail: string = '';
  @StorageLink('runtimeSmokeFinished') finished: boolean = false;

  build() {
    Row() {
      Column({ space: 24 }) {
        Text('底层兼容性检查').fontSize(28).fontWeight(FontWeight.Bold);
        Text(this.status).id('runtimeSmokeStatus').fontSize(22);
        Text(this.detail).fontSize(16).lineHeight(24);
        Button('返回首页').enabled(this.finished).onClick(() => {
          this.getUIContext().getRouter().replaceUrl({ url: 'pages/Index' });
        });
      }.width(formContentWidth(this.windowWidthVp)).height('100%').padding(28).justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Start);
    }.width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor('#F5F7FA');
  }
}
