import { ConnectionFailure, failureStageLabel, failureProblem, failureSuggestion } from '../model/ConnectionFailure';

@Component
export struct FailureNotice {
  @Prop title: string = '操作未完成';
  @Prop stage: string = '';
  @Prop reason: string = 'failed';
  @Prop idPrefix: string = 'operationFailure';

  private failure(): ConnectionFailure { return new ConnectionFailure(this.stage, this.reason, 0); }

  build() {
    Column({ space: 10 }) {
      Text(this.title).id(`${this.idPrefix}Title`).fontSize(16).fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary')).width('100%');
      Text('失败位置：' + failureStageLabel(this.stage)).id(`${this.idPrefix}Stage`).fontSize(14)
        .fontColor($r('app.color.warning')).width('100%');
      Text(failureProblem(this.failure())).id(`${this.idPrefix}Problem`).fontSize(14)
        .fontColor($r('app.color.text_primary')).width('100%');
      Text('建议：' + failureSuggestion(this.failure())).id(`${this.idPrefix}Suggestion`).fontSize(13)
        .fontColor($r('app.color.text_secondary')).width('100%');
    }.width('100%').padding(16).alignItems(HorizontalAlign.Start)
      .backgroundColor($r('app.color.surface_secondary')).borderRadius(14);
  }
}
