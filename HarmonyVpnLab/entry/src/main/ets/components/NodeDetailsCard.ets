@Component
export struct NodeDetailsCard {
  @Prop nodeName: string = '';
  @Prop source: string = '';
  @Prop favorite: boolean = false;
  @Prop selected: boolean = false;
  @Prop latency: string = '';
  @Prop editable: boolean = false;
  onSelect: () => void = () => {};
  onEdit: () => void = () => {};

  build() {
    Column({ space: 12 }) {
      Text(this.nodeName).id('nodeDetailName').fontSize(18).fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary')).width('100%').wordBreak(WordBreak.BREAK_ALL);
      Text(this.selected ? '当前选用的节点' : '正在查看 · 尚未选用').id('nodeDetailSelection')
        .fontSize(13).fontColor($r('app.color.accent')).width('100%');
      Text(this.source).id('nodeDetailSource').fontSize(14).fontColor($r('app.color.text_secondary'))
        .width('100%').wordBreak(WordBreak.BREAK_ALL);
      Text(this.favorite ? '★ 已收藏' : '☆ 未收藏').id('nodeDetailFavorite').fontSize(14)
        .fontColor($r('app.color.text_secondary')).width('100%');
      Text(this.latency).fontSize(13).lineHeight('20fp').fontColor($r('app.color.text_secondary')).width('100%');
      Button(this.selected ? '已选用' : '选用此节点').id('selectDetailNode').width('100%').constraintSize({ minHeight: 44 })
        .fontSize(14).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
        .enabled(this.editable && !this.selected).onClick(() => { this.onSelect(); });
      Button('编辑节点', { type: ButtonType.Normal }).id('editDetailNode').width('100%').constraintSize({ minHeight: 44 })
        .fontSize(14).borderRadius(12).fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface_secondary'))
        .enabled(this.editable).onClick(() => { this.onEdit(); });
    }.width('100%').padding(16).borderRadius(16).backgroundColor($r('app.color.surface'))
      .border({ width: 1, color: $r('app.color.border') }).alignItems(HorizontalAlign.Start);
  }
}
