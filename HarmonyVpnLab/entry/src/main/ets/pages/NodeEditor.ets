import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { readNodeCatalog, SavedNode, updateCatalogNode } from '../model/NodeCatalog';
import { ImportedNode } from '../model/NodeImport';
import { isNodeManagementAllowed } from '../model/NodeEditGuard';
import { NodeEditorDraft, nodeEditorDraft, nodeFromEditorDraft, nodeFromEditorJson } from '../model/NodeEditor';
import { formContentWidth } from '../model/AdaptiveLayout';
import { nodeIssue, nodeIssueFromError } from '../model/NodeIssue';

interface NodeEditorParams { nodeId?: string; }

@Entry
@Component
struct NodeEditor {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State draft: NodeEditorDraft = new NodeEditorDraft();
  @State loaded: boolean = false;
  @State editable: boolean = false;
  @State jsonMode: boolean = false;
  @State jsonText: string = '';
  @State fromSubscription: boolean = false;
  @State message: string = '';
  @State dirty: boolean = false;
  @State confirmingLeave: boolean = false;
  @State leaving: boolean = false;
  @State portError: string = '';
  @State issueCode: string = '';
  private nodeId: string = '';
  private revision: number = -1;
  private original?: ImportedNode;
  private baseline?: ImportedNode;
  private pageEpoch: number = 0;
  private leaveRequest: number = 0;

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void {
    // A live editor owns its draft until save/discard. Visibility or dialog
    // lifecycle re-entry must not reload the persisted baseline over that draft.
    if (this.loaded) { this.refreshEditable(); return; }
    this.pageEpoch++; this.confirmingLeave = false; this.leaving = false; this.load();
  }
  onPageShow(): void { this.refreshEditable(); }
  aboutToDisappear(): void {
    this.pageEpoch++; this.leaveRequest++; this.confirmingLeave = false;
    this.clearDraft();
  }

  private clearDraft(): void {
    this.original = undefined; this.baseline = undefined; this.jsonText = ''; this.draft = new NodeEditorDraft();
    this.loaded = false; this.dirty = false; this.portError = ''; this.issueCode = '';
  }

  private editedNode(): ImportedNode {
    if (!this.original) { throw new Error('not loaded'); }
    return this.jsonMode ? nodeFromEditorJson(this.draft.name, this.jsonText) : nodeFromEditorDraft(this.original, this.draft);
  }

  private refreshDirty(): void {
    if (!this.loaded || !this.original || !this.baseline) { this.dirty = false; return; }
    try {
      const edited = this.editedNode();
      this.dirty = edited.name !== this.baseline.name || edited.protocol !== this.baseline.protocol ||
        edited.outboundJson !== this.baseline.outboundJson;
    } catch (_) { this.dirty = true; }
  }

  private draftChanged(): void {
    this.message = '';
    this.issueCode = '';
    this.portError = !this.jsonMode && (!/^[0-9]{1,5}$/.test(this.draft.port) ||
      Number(this.draft.port) < 1 || Number(this.draft.port) > 65535) ? '端口应为 1–65535 的整数。' : '';
    this.refreshDirty();
  }

  private fieldValue(id: string): string {
    // Read reactive state inside the builder, never a captured scalar argument.
    const draft = this.draft;
    switch (id) {
      case 'editNodeName': return draft.name;
      case 'editNodeAddress': return draft.address;
      case 'editNodePort': return draft.port;
      case 'editNodeCredential': return draft.credential;
      case 'editNodeMethod': return draft.method;
      case 'editNodeFlow': return draft.flow;
      case 'editNodeSni': return draft.serverName;
      case 'editNodeFingerprint': return draft.fingerprint;
      case 'editNodeAlpn': return draft.alpn;
      case 'editNodePublicKey': return draft.publicKey;
      case 'editNodeShortId': return draft.shortId;
      case 'editNodeSpiderX': return draft.spiderX;
      case 'editNodeWsHost': return draft.transportHost;
      case 'editNodeWsPath': return draft.transportPath;
      case 'editNodeGrpcService': return draft.serviceName;
      case 'editNodeGrpcAuthority': return draft.authority;
      default: return '';
    }
  }

  private changeField(id: string, text: string): void {
    if (!this.loaded || !this.editable || this.confirmingLeave || this.leaving) { return; }
    // Replace the observed object instead of mutating a class property through
    // a callback captured by a parameterized builder.
    const next = JSON.parse(JSON.stringify(this.draft)) as NodeEditorDraft;
    switch (id) {
      case 'editNodeName': next.name = text; break;
      case 'editNodeAddress': next.address = text; break;
      case 'editNodePort': next.port = text; break;
      case 'editNodeCredential': next.credential = text; break;
      case 'editNodeMethod': next.method = text; break;
      case 'editNodeFlow': next.flow = text; break;
      case 'editNodeSni': next.serverName = text; break;
      case 'editNodeFingerprint': next.fingerprint = text; break;
      case 'editNodeAlpn': next.alpn = text; break;
      case 'editNodePublicKey': next.publicKey = text; break;
      case 'editNodeShortId': next.shortId = text; break;
      case 'editNodeSpiderX': next.spiderX = text; break;
      case 'editNodeWsHost': next.transportHost = text; break;
      case 'editNodeWsPath': next.transportPath = text; break;
      case 'editNodeGrpcService': next.serviceName = text; break;
      case 'editNodeGrpcAuthority': next.authority = text; break;
      default: return;
    }
    this.draft = next;
    this.draftChanged();
  }

  private changeJson(text: string): void {
    if (!this.loaded || !this.editable || this.confirmingLeave || this.leaving) { return; }
    this.jsonText = text; this.draftChanged();
  }

  onBackPress(): boolean {
    if (this.confirmingLeave || this.leaving) { return true; }
    this.refreshDirty();
    if (!this.dirty) { return false; }
    void this.requestBack();
    return true;
  }

  private async requestBack(): Promise<void> {
    if (this.confirmingLeave || this.leaving) { return; }
    this.refreshDirty();
    if (!this.dirty) {
      this.leaving = true;
      try { this.getUIContext().getRouter().back(); }
      catch (_) { this.leaving = false; this.message = '暂时无法返回，请重试。'; }
      return;
    }
    const epoch = this.pageEpoch;
    const request = ++this.leaveRequest;
    this.confirmingLeave = true;
    try {
      const result = await this.getUIContext().getPromptAction().showDialog({
        title: '放弃未保存的修改？',
        message: '返回后，这次未保存的修改将丢失。',
        buttons: [
          { text: '继续编辑', color: $r('app.color.accent') },
          { text: '放弃修改', color: $r('app.color.danger') }
        ]
      });
      if (epoch !== this.pageEpoch || request !== this.leaveRequest) { return; }
      if (result.index === 1) {
        this.leaving = true;
        this.getUIContext().getRouter().back();
        this.clearDraft();
      }
    } catch (_) {
      if (epoch === this.pageEpoch && request === this.leaveRequest) {
        this.leaving = false;
        this.message = '返回确认未完成，修改已保留，请继续编辑或重试。';
      }
    } finally {
      if (epoch === this.pageEpoch && request === this.leaveRequest) { this.confirmingLeave = false; }
    }
  }

  private refreshEditable(): void {
    try { this.editable = isNodeManagementAllowed(this.context().filesDir); }
    catch (_) { this.editable = false; }
  }

  private load(): void {
    this.clearDraft();
    try {
      const params = this.getUIContext().getRouter().getParams() as NodeEditorParams;
      if (!params || typeof params.nodeId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(params.nodeId)) {
        throw new Error('invalid');
      }
      const catalog = readNodeCatalog(this.context().filesDir);
      const node = catalog.nodes.find((item: SavedNode) => item.id === params.nodeId);
      if (!node) { throw new Error('missing'); }
      this.nodeId = node.id; this.revision = catalog.revision;
      this.original = new ImportedNode(node.name, node.protocol, node.outboundJson);
      this.baseline = new ImportedNode(node.name, node.protocol, node.outboundJson);
      this.draft = nodeEditorDraft(this.original);
      this.fromSubscription = node.sourceId.length > 0;
      this.jsonText = ''; this.jsonMode = false; this.loaded = true;
      this.message = ''; this.portError = ''; this.refreshDirty();
      this.refreshEditable();
    } catch (_) { this.loaded = false; this.editable = false; this.message = '节点无法读取，请返回列表后重试。'; }
  }

  private switchEditor(): void {
    if (!this.original || !this.loaded || this.confirmingLeave || this.leaving) { return; }
    try {
      if (this.jsonMode) {
        const edited = nodeFromEditorJson(this.draft.name, this.jsonText);
        this.draft = nodeEditorDraft(edited); this.original = edited;
        this.jsonText = ''; this.jsonMode = false;
      } else {
        const edited = nodeFromEditorDraft(this.original, this.draft);
        this.jsonText = edited.outboundJson; this.original = edited; this.jsonMode = true;
      }
      this.message = '';
      this.portError = ''; this.refreshDirty();
    } catch (error) {
      this.issueCode = nodeIssueFromError(error as Object)?.code ?? '';
      this.message = '当前内容未通过校验，已保留输入；请修正后再切换编辑方式。';
    }
  }

  private save(): void {
    if (!this.original || !this.loaded || this.confirmingLeave || this.leaving) { return; }
    this.refreshDirty();
    if (!this.dirty) { this.message = '没有需要保存的修改。'; return; }
    this.refreshEditable();
    if (!this.editable) { this.message = '请先断开连接并等待清理完成，再保存修改。'; return; }
    this.draftChanged();
    if (this.portError) { this.issueCode = 'port-format'; this.message = this.portError; return; }
    let committed: boolean = false;
    try {
      const edited = this.editedNode();
      updateCatalogNode(this.context().filesDir, this.nodeId, edited, this.revision);
      committed = true;
      const catalog = readNodeCatalog(this.context().filesDir);
      const saved = catalog.nodes.find((item: SavedNode) => item.id === this.nodeId);
      if (!saved || saved.outboundJson !== edited.outboundJson) {
        this.message = '保存已提交，但读回未确认，请返回列表核对。'; return;
      }
      this.revision = catalog.revision;
      this.original = new ImportedNode(saved.name, saved.protocol, saved.outboundJson);
      this.baseline = new ImportedNode(saved.name, saved.protocol, saved.outboundJson);
      this.draft = nodeEditorDraft(this.original);
      if (this.jsonMode) { this.jsonText = saved.outboundJson; }
      this.refreshDirty();
      this.issueCode = '';
      this.message = '节点修改已保存，原选中项保持不变。';
    } catch (error) {
      const issue = !committed ? nodeIssueFromError(error as Object) : undefined;
      if (issue) {
        this.issueCode = issue.code;
        this.message = '配置未通过检查，输入已保留；请按字段提示修正。'; return;
      }
      const safeErrors: string[] = [
        '节点库已发生变化，请返回列表后重新打开编辑。',
        '相同配置的节点已存在，请直接选择该节点。',
        '节点参数未通过校验，请检查地址、端口、认证和传输参数。',
        'JSON 未通过校验，请使用不超过 64 KiB 的受支持单个 outbound。'
      ];
      this.message = committed ? '保存已提交，但读回未确认，请返回列表核对。' :
        error instanceof Error && safeErrors.includes(error.message) ? error.message : '保存未完成，输入已保留，请检查参数后重试。';
    }
  }

  build() {
    Column() {
      Row({ space: 14 }) {
        Button('‹ 返回', { type: ButtonType.Normal }).id('backFromNodeEditor').constraintSize({ minHeight: 44 })
          .fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface')).borderRadius(12)
          .enabled(!this.confirmingLeave && !this.leaving).onClick(() => { void this.requestBack(); });
        Text('编辑节点').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1);
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, top: 12, bottom: 16 });
      Scroll() {
        Column({ space: 18 }) {
          if (this.loaded) {
            Column({ space: 14 }) {
              this.field('节点名称', 'editNodeName', false, 64);
              Text(`${this.draft.protocol.toUpperCase()} · ${this.draft.network.toUpperCase()} · ${this.draft.security.toUpperCase()}`)
                .id('editNodeProtocol').fontSize(14).fontColor($r('app.color.text_secondary'));
              if (this.fromSubscription) {
                Text('此节点来自订阅；下次更新订阅可能覆盖手动修改。').fontSize(13).fontColor($r('app.color.warning'));
              }
              if (!this.editable) { Text('连接运行或清理期间不能保存节点修改。').fontSize(13).fontColor($r('app.color.warning')); }
            }.padding(20).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);

            if (this.issueCode) {
              Column({ space: 8 }) {
                Text(nodeIssue(this.issueCode).field).id('nodeEditorIssueField').fontSize(15).fontWeight(FontWeight.Medium)
                  .fontColor($r('app.color.text_primary')).width('100%');
                Text(nodeIssue(this.issueCode).problem).id('nodeEditorIssueProblem').fontSize(14)
                  .fontColor($r('app.color.danger')).width('100%');
                Text('建议：' + nodeIssue(this.issueCode).suggestion).id('nodeEditorIssueSuggestion').fontSize(13)
                  .fontColor($r('app.color.text_secondary')).width('100%');
              }.padding(16).width('100%').alignItems(HorizontalAlign.Start)
                .backgroundColor($r('app.color.surface')).borderRadius(14);
            }

            if (this.jsonMode) {
              Column({ space: 12 }) {
                Text('完整 outbound JSON').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
                Text('这里显示完整连接配置。支持现有四种协议的单个 outbound；保存前会重新校验。')
                  .fontSize(13).fontColor($r('app.color.text_secondary')).lineHeight('21fp');
                TextArea({ text: this.jsonText, placeholder: '单个 outbound JSON' }).id('editNodeJson').height(360)
                  .enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1')
                  .fontSize(13).fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.surface_secondary'))
                  .maxLength(65536).enabled(this.editable && !this.leaving)
                  .onChange((value: string) => { this.changeJson(value); });
              }.padding(20).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);
            } else {
              Column({ space: 14 }) {
                Text('连接参数').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
                this.field('服务器 IP 或域名', 'editNodeAddress', false, 253);
                this.field('端口', 'editNodePort', false, 5);
                this.field(['vless', 'vmess'].includes(this.draft.protocol) ? '用户 UUID' : '密码', 'editNodeCredential', true, 4096);
                if (this.draft.protocol === 'shadowsocks') {
                  this.field('加密方法', 'editNodeMethod', false, 64);
                }
                if (this.draft.protocol === 'vless') {
                  this.field('Flow（可留空）', 'editNodeFlow', false, 64);
                }
              }.padding(20).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);

              if (this.draft.security === 'tls' || this.draft.security === 'reality') {
                Column({ space: 14 }) {
                  Text('TLS / REALITY').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
                  this.field('服务器名称 SNI', 'editNodeSni', false, 253);
                  this.field('客户端指纹', 'editNodeFingerprint', false, 64);
                  if (this.draft.security === 'tls') {
                    this.field('ALPN（英文逗号分隔）', 'editNodeAlpn', false, 256);
                  } else {
                    this.field('REALITY 公钥', 'editNodePublicKey', false, 256);
                    this.field('Short ID', 'editNodeShortId', false, 64);
                    this.field('Spider X（可留空）', 'editNodeSpiderX', false, 1024);
                  }
                }.padding(20).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);
              }
              if (this.draft.network === 'ws' || this.draft.network === 'grpc') {
                Column({ space: 14 }) {
                  Text('传输参数').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
                  if (this.draft.network === 'ws') {
                    this.field('WebSocket Host', 'editNodeWsHost', false, 253);
                    this.field('WebSocket Path', 'editNodeWsPath', false, 2048);
                  } else {
                    this.field('gRPC Service Name', 'editNodeGrpcService', false, 1024);
                    this.field('gRPC Authority', 'editNodeGrpcAuthority', false, 253);
                  }
                }.padding(20).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);
              }
            }
            Button(this.jsonMode ? '返回参数表单' : '打开完整 JSON 编辑').id('toggleNodeJsonEditor').width('100%')
              .constraintSize({ minHeight: 46 }).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .enabled(this.editable && !this.confirmingLeave && !this.leaving)
              .onClick(() => { this.switchEditor(); });
            Text('表单只修改所显示的字段，其余配置保留。协议、传输类型和其他高级参数可在 JSON 中修改。')
              .fontSize(13).fontColor($r('app.color.text_secondary')).lineHeight('21fp');
          }
        }.padding(20).width(formContentWidth(this.windowWidthVp)).alignItems(HorizontalAlign.Start);
      }.layoutWeight(1).width('100%').align(Alignment.Top);
      Column({ space: 8 }) {
        if (this.loaded) {
          Text(this.dirty ? '有未保存的修改' : '没有未保存的修改').id('nodeEditorDirtyState')
            .fontSize(13).fontColor(this.dirty ? $r('app.color.warning') : $r('app.color.text_secondary')).width('100%');
        }
        if (this.message.length > 0) {
          Text(this.message).id('nodeEditorResult').fontSize(14).lineHeight('22fp')
            .fontColor($r('app.color.text_primary')).width('100%');
        }
        Button('保存修改').id('saveNodeEditor').width('100%').constraintSize({ minHeight: 50 })
          .enabled(this.loaded && this.editable && this.dirty && !this.confirmingLeave && !this.leaving)
          .backgroundColor($r('app.color.accent')).fontColor(Color.White).onClick(() => { this.save(); });
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, top: 10, bottom: 18 })
        .backgroundColor($r('app.color.page_bg')).alignItems(HorizontalAlign.Start);
    }.width('100%').height('100%').alignItems(HorizontalAlign.Center).background($r('app.color.page_bg'));
  }

  @Builder
  private field(label: string, id: string, sensitive: boolean, limit: number) {
    Column({ space: 7 }) {
      Text(label).fontSize(13).fontColor($r('app.color.text_secondary'));
      TextInput({ text: this.fieldValue(id), placeholder: label }).id(id).maxLength(limit)
        .enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1')
        .type(sensitive ? InputType.Password : id === 'editNodePort' ? InputType.Number : InputType.Normal)
        .fontSize(15).fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.surface_secondary'))
        // Native modal focus already blocks interaction. Toggling enabled here
        // can cause the text control to reapply a stale construction value.
        .constraintSize({ minHeight: 46 }).enabled(this.editable && !this.leaving)
        .onChange((text: string) => { this.changeField(id, text); });
      if (id === 'editNodePort' && this.portError) {
        Text(this.portError).id('editNodePortError').fontSize(13).fontColor($r('app.color.danger'));
        Text(nodeIssue('port-format').suggestion).fontSize(12).fontColor($r('app.color.text_secondary')).width('100%');
      }
    }.width('100%').alignItems(HorizontalAlign.Start);
  }
}
