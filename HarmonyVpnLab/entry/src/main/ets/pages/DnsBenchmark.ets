import { common } from '@kit.AbilityKit';
import { VPN_CORE_AVAILABLE } from '../model/BuildCapabilities';
import { formContentWidth } from '../model/AdaptiveLayout';
import { DnsBenchmarkRun } from '../model/DnsBenchmark';

@Entry
@Component
struct DnsBenchmark {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State status: string = '准备测量';
  @State detail: string = '';
  @State busy: boolean = false;
  private run?: DnsBenchmarkRun;
  private alive: boolean = false;

  aboutToAppear(): void { this.alive = true; void this.start(); }
  onPageHide(): void { this.stop(); }
  aboutToDisappear(): void { this.stop(); }
  onBackPress(): boolean { this.stop(); return false; }
  private stop(): void { this.alive = false; this.run?.cancel(); this.busy = false; }

  private async start(): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const target = AppStorage.get<string>('dnsBenchmarkTarget') ?? '';
    const token = AppStorage.get<string>('dnsBenchmarkToken') ?? '';
    this.run = new DnsBenchmarkRun(); this.busy = true;
    this.status = '测量中';
    const description = target === 'https-cloudflare-keepalive' ?
      'HTTPS 串行完整 GET 两次；第二次请求允许复用连接，是否复用以 SDK 实际回报为准。结果不代表纯 RTT，也不保证全链路冷缓存。' :
      'DNS 连续查询两次；HTTPS 使用完整 GET。结果不代表纯 RTT，也不保证全链路冷缓存。';
    this.detail = `${target}\n${description}`;
    const result = await this.run.run(context.filesDir, target, token,
      context.applicationInfo.debug && VPN_CORE_AVAILABLE);
    if (!this.alive) { return; }
    this.busy = false;
    this.status = result.status === 'passed' ? '测量完成' : '测量未完成';
    this.detail = `${result.target}\n${result.reason || 'passed'}\n` + result.samples.map((sample) =>
      `${sample.stage}: ${sample.status}, ${sample.durationMs} ms` +
      (target === 'https-cloudflare-keepalive' ?
        `, SDK 连接复用: ${sample.connection?.isReusedConnection === undefined ? '未报告' : sample.connection?.isReusedConnection ? '是' : '否'}` : '')).join('\n') +
      (target === 'https-cloudflare-keepalive' ? `\n${description}` : '');
  }

  build() {
    Row() {
      Column({ space: 20 }) {
        Text('DNS 与 HTTPS 对照测量').fontSize(26).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
        Text(this.status).id('dnsBenchmarkStatus').fontSize(22).fontColor($r('app.color.text_primary'));
        Text(this.detail).id('dnsBenchmarkDetail').fontSize(16).lineHeight(24).fontColor($r('app.color.text_primary'));
        Text('仅测量当前 VPN，不改变连接、节点或网络设置。').fontSize(14).fontColor($r('app.color.text_secondary'));
        if (this.busy) {
          Button('取消测量').id('dnsBenchmarkCancel').onClick(() => { this.run?.cancel(); });
        }
        Button('返回首页').id('dnsBenchmarkHome').onClick(() => {
          this.stop(); this.getUIContext().getRouter().replaceUrl({ url: 'pages/Home' });
        });
      }.width(formContentWidth(this.windowWidthVp)).padding(28).alignItems(HorizontalAlign.Start);
    }.width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor($r('app.color.page_bg'));
  }
}
