import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { NetworkPolicy, parseRoutingEntries } from '../model/NetworkPolicy';
import { readNetworkPolicy, saveNetworkPolicy } from '../model/NetworkPolicyStore';
import { isNodeManagementAllowed } from '../model/NodeEditGuard';
import { formContentWidth } from '../model/AdaptiveLayout';
import { MAX_ROUTED_APPS, OWN_VPN_BUNDLE, normalizeAppBundle } from '../model/AppRouting';
import { AppCandidate, COMMON_APP_CANDIDATES } from '../model/AppCandidates';


@Entry
@Component
struct NetworkSettings {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State mode: string = 'global';
  @State bypassLan: boolean = false;
  @State direct: string = '';
  @State proxy: string = '';
  @State block: string = '';
  @State dnsUrl: string = 'https://1.1.1.1/dns-query';
  @State dnsMode: string = 'proxy';
  @State directDnsUrl: string = 'https://223.5.5.5/dns-query';
  @State appMode: string = 'all';
  @State appBundles: string[] = [];
  @State appSearch: string = '';
  @State appInput: string = '';
  @State appMessage: string = '';
  @State appPickerOpen: boolean = false;
  @State message: string = '';
  @State editable: boolean = false;
  @State dirty: boolean = false;
  @State confirmingLeave: boolean = false;
  @State leaving: boolean = false;
  @State needsRepair: boolean = false;
  private baseline: string = '';
  private pageEpoch: number = 0;
  private leaveRequest: number = 0;

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void {
    this.pageEpoch++; this.confirmingLeave = false; this.leaving = false;
    this.appInput = ''; this.appSearch = ''; this.appMessage = ''; this.appPickerOpen = false;
    this.baseline = this.snapshot(); this.dirty = false; this.needsRepair = false;
    this.refreshEditable();
    try { this.load(readNetworkPolicy(this.context().filesDir)); }
    catch (_) { this.needsRepair = true; this.message = '原网络设置无法读取。请检查并保存下面的设置，保存成功后才会替换原文件。'; }
  }
  onPageShow(): void { this.refreshEditable(); }
  onPageHide(): void { this.pageEpoch++; this.leaveRequest++; this.confirmingLeave = false; }
  aboutToDisappear(): void { this.pageEpoch++; this.leaveRequest++; this.confirmingLeave = false; }
  private refreshEditable(): void {
    try { this.editable = isNodeManagementAllowed(this.context().filesDir); }
    catch (_) { this.editable = false; }
  }
  private snapshot(): string {
    return JSON.stringify([this.mode, String(this.bypassLan), this.direct, this.proxy, this.block, this.dnsUrl,
      this.dnsMode, this.directDnsUrl, this.appMode, this.appBundles.slice().sort(), this.appInput]);
  }
  private draftChanged(): void { this.dirty = this.snapshot() !== this.baseline; this.message = ''; }
  onBackPress(): boolean {
    if (this.confirmingLeave || this.leaving) { return true; }
    if (this.snapshot() === this.baseline) { return false; }
    void this.requestBack(); return true;
  }
  private async requestBack(): Promise<void> {
    if (this.confirmingLeave || this.leaving) { return; }
    if (this.snapshot() === this.baseline) {
      this.leaving = true;
      try { this.getUIContext().getRouter().back(); }
      catch (_) { this.leaving = false; this.message = '暂时无法返回，请重试。'; }
      return;
    }
    const epoch = this.pageEpoch; const request = ++this.leaveRequest;
    this.confirmingLeave = true;
    try {
      const result = await this.getUIContext().getPromptAction().showDialog({
        title: '放弃未保存的设置？', message: '返回后，这次未保存的应用范围、分流与 DNS 修改将丢失。',
        buttons: [{ text: '继续编辑', color: $r('app.color.accent') }, { text: '放弃修改', color: $r('app.color.danger') }]
      });
      if (epoch !== this.pageEpoch || request !== this.leaveRequest) { return; }
      if (result.index === 1) { this.leaving = true; this.getUIContext().getRouter().back(); }
    } catch (_) {
      if (epoch === this.pageEpoch && request === this.leaveRequest) {
        this.leaving = false; this.message = '返回确认未完成，输入已保留，请继续编辑或重试。';
      }
    } finally { if (epoch === this.pageEpoch && request === this.leaveRequest) { this.confirmingLeave = false; } }
  }
  private load(policy: NetworkPolicy): void {
    this.mode = policy.mode; this.bypassLan = policy.bypassLan;
    this.direct = policy.direct.join('\n'); this.proxy = policy.proxy.join('\n'); this.block = policy.block.join('\n');
    this.dnsUrl = policy.dnsUrl;
    this.dnsMode = policy.dnsMode; this.directDnsUrl = policy.directDnsUrl;
    this.appMode = policy.appMode; this.appBundles = policy.appBundles.slice();
    this.baseline = this.snapshot(); this.dirty = false; this.needsRepair = false;
  }
  private save(): void {
    if (this.confirmingLeave || this.leaving) { return; }
    if (this.appInput.length > 0) {
      this.message = '还有未添加的应用包名。请先核对并添加，或清空输入后保存。'; return;
    }
    this.dirty = this.snapshot() !== this.baseline;
    if (!this.dirty && !this.needsRepair) { return; }
    this.refreshEditable();
    if (!this.editable) { this.message = '请先断开连接并等待清理完成，再保存网络设置。'; return; }
    let committed: boolean = false;
    try {
      const policy = new NetworkPolicy();
      policy.mode = this.mode; policy.bypassLan = this.bypassLan;
      policy.direct = parseRoutingEntries(this.direct); policy.proxy = parseRoutingEntries(this.proxy);
      policy.block = parseRoutingEntries(this.block); policy.dnsUrl = this.dnsUrl.trim();
      policy.dnsMode = this.dnsMode; policy.directDnsUrl = this.directDnsUrl.trim();
      policy.appMode = this.appMode; policy.appBundles = this.appBundles.slice();
      saveNetworkPolicy(this.context().filesDir, policy);
      committed = true;
      // A successful atomic commit is distinct from a failed subsequent read.
      this.baseline = this.snapshot(); this.dirty = false; this.needsRepair = false;
      this.load(readNetworkPolicy(this.context().filesDir));
      this.message = '网络设置已保存，下次连接时生效。';
    } catch (error) {
      const safeErrors: string[] = [
        '分流条目格式无效。', '请使用标准 IPv4 地址或 CIDR 网段。',
        '分流域名无效；支持普通域名、domain:域名、full:域名和 IPv4 网段。',
        '分流列表过长。', '每类分流最多 300 条。', '分流列表格式无效。',
        'DNS 地址需为有效的 HTTPS URL。', 'DNS 地址需包含 HTTPS 域名或 IPv4 地址及路径，不支持账号、片段或 IPv6 地址。',
        'DNS 服务器地址格式无效。', '网络设置超过 32 KiB，未保存。', '网络设置未保存，原设置已保留。',
        'DNS 查询模式无效。', '直连 DNS 地址需为 HTTPS IPv4 地址及路径。', '直连 DNS 服务器地址不可用。',
        '应用代理范围无效。', '应用列表格式无效或超过 255 项。',
        '请至少选择一个应用，或切换到全部应用。', '本应用自动参与连接检查，无需加入应用选择列表。',
        '应用包名格式无效；需为 7 至 128 位且至少三段，以字母开头，各段以字母或数字结尾。'
      ];
      this.message = committed ? '保存已提交，但设置读回未确认，请返回后重新打开核对。' :
        (error instanceof Error && safeErrors.includes(error.message) ? error.message : '网络设置未保存，输入已保留；请检查输入并先断开连接。');
    }
  }

  private changeAppMode(mode: string): void {
    this.refreshEditable();
    if (!this.editable || this.confirmingLeave || this.leaving ||
      !['all', 'exclude', 'include'].includes(mode)) { return; }
    this.appMode = mode; this.draftChanged();
  }

  private changeRoutingMode(mode: string): void {
    this.refreshEditable();
    if (!this.editable || this.confirmingLeave || this.leaving ||
      !['global', 'whitelist', 'rules'].includes(mode)) { return; }
    this.mode = mode; this.draftChanged();
  }

  private changeDnsMode(mode: string): void {
    this.refreshEditable();
    if (!this.editable || this.confirmingLeave || this.leaving || !['proxy', 'split'].includes(mode)) { return; }
    this.dnsMode = mode; this.draftChanged();
  }

  private resetDnsUrl(direct: boolean): void {
    this.refreshEditable();
    if (!this.editable || this.confirmingLeave || this.leaving) { return; }
    if (direct) { this.directDnsUrl = 'https://223.5.5.5/dns-query'; }
    else { this.dnsUrl = 'https://1.1.1.1/dns-query'; }
    this.draftChanged();
  }

  private dnsModeHint(): string {
    if (this.dnsMode !== 'split') { return '默认全部经节点查询。白名单 DNS 分流未开启。'; }
    if (this.mode !== 'whitelist') { return '分流选择和直连 DNS 地址已保留；当前不是白名单模式，DNS 仍全部经节点查询。'; }
    return '白名单 DNS 分流将在下次连接时生效。Google 类别优先经节点；内置的大陆、私有及 DNS 服务域名类别直接查询，其余域名经节点。';
  }

  private appName(bundle: string): string {
    return COMMON_APP_CANDIDATES.find((app: AppCandidate) => app.bundleName === bundle)?.name ?? bundle;
  }

  private visibleAppChoices(): AppCandidate[] {
    const query = this.appSearch.trim().toLowerCase();
    return COMMON_APP_CANDIDATES.filter((app: AppCandidate) => !this.appBundles.includes(app.bundleName) &&
      (query.length === 0 || app.name.toLowerCase().includes(query) || app.bundleName.toLowerCase().includes(query)));
  }

  private toggleApp(bundle: string, selected: boolean): void {
    this.refreshEditable();
    if (!this.editable || this.confirmingLeave || this.leaving || this.appMode === 'all') { return; }
    if (!selected) { this.appBundles = this.appBundles.filter((item: string) => item !== bundle); this.draftChanged(); return; }
    if (bundle === OWN_VPN_BUNDLE || !COMMON_APP_CANDIDATES.some((app: AppCandidate) => app.bundleName === bundle)) { return; }
    if (this.appBundles.includes(bundle)) { return; }
    if (this.appBundles.length >= MAX_ROUTED_APPS) { this.appMessage = '最多选择 255 个应用。'; return; }
    this.appBundles = [...this.appBundles, bundle]; this.draftChanged();
  }

  private refreshAppChoices(): void {
    this.refreshEditable();
    if (!this.editable || this.confirmingLeave || this.leaving || this.appMode === 'all') { return; }
    this.appPickerOpen = !this.appPickerOpen;
  }

  private addAppByBundle(): void {
    this.refreshEditable();
    if (!this.editable || this.confirmingLeave || this.leaving || this.appMode === 'all') { return; }
    let bundle: string = '';
    try { bundle = normalizeAppBundle(this.appInput.trim()); }
    catch (_) { this.appMessage = '请填写完整的鸿蒙应用包名，如 com.example.reader，而不是应用名称。'; return; }
    if (bundle === OWN_VPN_BUNDLE) { this.appMessage = 'Harmony VPN 已固定参与连接检查，无需添加。'; return; }
    if (this.appBundles.includes(bundle)) { this.appMessage = '这个应用已经在所选列表中。'; return; }
    if (this.appBundles.length >= MAX_ROUTED_APPS) { this.appMessage = '最多选择 255 个应用。'; return; }
    this.appBundles = [...this.appBundles, bundle]; this.appInput = '';
    this.appMessage = '已加入所选应用。安装状态未自动核实，请确认包名对应本机已安装的鸿蒙应用后保存。';
    this.draftChanged();
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回').id('backFromNetworkSettings').fontColor($r('app.color.accent'))
          .backgroundColor($r('app.color.accent_soft')).enabled(!this.confirmingLeave && !this.leaving)
          .onClick(() => { void this.requestBack(); });
        Text('网络设置').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1);
      }.width(formContentWidth(this.windowWidthVp)).padding(20);
      Scroll() {
        Column({ space: 18 }) {
          if (!this.editable) { Text('请先断开连接并等待清理完成，再修改设置。').fontColor($r('app.color.warning')); }
          Column({ space: 12 }) {
            Text('应用范围').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Flex({ wrap: FlexWrap.Wrap }) {
              Button(this.appMode === 'all' ? '✓ 全部应用' : '全部应用').id('networkAppAll')
                .constraintSize({ minHeight: 44, maxWidth: '100%' }).margin({ right: 8, bottom: 8 })
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving)
                .onClick(() => { this.changeAppMode('all'); });
              Button(this.appMode === 'exclude' ? '✓ 绕过所选应用' : '绕过所选应用').id('networkAppExclude')
                .constraintSize({ minHeight: 44, maxWidth: '100%' }).margin({ right: 8, bottom: 8 })
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving)
                .onClick(() => { this.changeAppMode('exclude'); });
              Button(this.appMode === 'include' ? '✓ 仅代理所选应用' : '仅代理所选应用').id('networkAppInclude')
                .constraintSize({ minHeight: 44, maxWidth: '100%' }).margin({ right: 8, bottom: 8 })
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving)
                .onClick(() => { this.changeAppMode('include'); });
            }.width('100%');
            Text(this.appMode === 'all' ? '所有应用进入 VPN。已有的应用选择会保留，当前不启用。' :
              this.appMode === 'exclude' ? '所选应用直接使用系统网络，其他应用进入 VPN。' :
                '只有所选应用进入 VPN，其他应用直接使用系统网络。')
              .id('networkAppScopeHint').fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            Text('Harmony VPN 始终参与 VPN，用于本应用的连接检查。绕过的应用不使用下面的 DNS 和分流规则，其 IPv6 也不由本应用阻断。')
              .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            if (this.appMode !== 'all') {
              Text(`已选择 ${this.appBundles.length} 个应用`).id('networkAppSelectedCount')
                .fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
              if (this.appBundles.length === 0) {
                Text('请至少选择一个应用后保存。').id('networkAppEmptyHint').fontSize(13).fontColor($r('app.color.warning'));
              }
              ForEach(this.appBundles, (bundle: string) => {
                Row({ space: 12 }) {
                  Column({ space: 4 }) {
                    Text(this.appName(bundle)).fontSize(16).fontColor($r('app.color.text_primary')).width('100%');
                    Text(bundle).fontSize(12).fontColor($r('app.color.text_secondary')).width('100%');
                  }.layoutWeight(1).alignItems(HorizontalAlign.Start);
                  Button('移除').id('removeApp-' + bundle).constraintSize({ minHeight: 44 })
                    .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                    .enabled(this.editable && !this.confirmingLeave && !this.leaving)
                    .onClick(() => { this.toggleApp(bundle, false); });
                }.width('100%').padding(12).borderRadius(12).backgroundColor($r('app.color.surface_secondary'));
              }, (bundle: string) => bundle);
              Button(this.appPickerOpen ? '收起常见应用预设' : '选择常见应用预设').id('refreshAppCandidates')
                .width('100%').constraintSize({ minHeight: 44 }).fontColor($r('app.color.accent'))
                .backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving)
                .onClick(() => { void this.refreshAppChoices(); });
              Text('以下为常见鸿蒙应用的包名预设，不是已安装列表。请按本机实际安装情况选择；未安装或包名不匹配的项目不会生效。')
                .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
              if (this.appPickerOpen) {
                TextInput({ text: this.appSearch, placeholder: '搜索预设应用的名称或包名' }).id('appCandidateSearch')
                  .enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').maxLength(128)
                  .enabled(!this.confirmingLeave && !this.leaving)
                  .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.surface_secondary'))
                  .onChange((value: string) => { this.appSearch = value; });
                ForEach(this.visibleAppChoices(), (app: AppCandidate) => {
                  Row({ space: 12 }) {
                    Column({ space: 4 }) {
                      Text(app.name).fontSize(16).fontColor($r('app.color.text_primary')).width('100%');
                      Text(app.bundleName).fontSize(12).fontColor($r('app.color.text_secondary')).width('100%');
                    }.layoutWeight(1).alignItems(HorizontalAlign.Start);
                    Checkbox({ name: app.bundleName }).id('selectApp-' + app.bundleName).select(false)
                      .selectedColor($r('app.color.accent'))
                      .enabled(this.editable && !this.confirmingLeave && !this.leaving)
                      .onChange((selected: boolean) => { this.toggleApp(app.bundleName, selected); });
                  }.width('100%').padding(12).borderRadius(12).backgroundColor($r('app.color.surface_secondary'));
                }, (app: AppCandidate) => app.bundleName);
              }
              Text('添加其他应用').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
              TextInput({ text: this.appInput, placeholder: '鸿蒙应用包名，例如 com.example.reader' }).id('appBundleInput')
                .enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').maxLength(128)
                .enabled(this.editable && !this.confirmingLeave && !this.leaving)
                .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.surface_secondary'))
                .onChange((value: string) => {
                  if (value === this.appInput) { return; }
                  this.appInput = value; this.appMessage = ''; this.draftChanged();
                });
              Button('添加到所选应用').id('addAppBundle').width('100%').constraintSize({ minHeight: 44 })
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving && this.appInput.trim().length > 0)
                .onClick(() => { void this.addAppByBundle(); });
              if (this.appMessage) {
                Text(this.appMessage).id('appCandidatesResult').fontSize(13).fontColor($r('app.color.text_secondary')).width('100%');
              }
            }
            if (this.appInput.length > 0) {
              Button('清空待添加包名').id('clearAppBundleInput').constraintSize({ minHeight: 44, maxWidth: '100%' })
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving)
                .onClick(() => { this.appInput = ''; this.appMessage = ''; this.draftChanged(); });
            }
          }.width('100%').padding(18).borderRadius(16).backgroundColor($r('app.color.surface'));
          Column({ space: 12 }) {
            Text('进入 VPN 后的流量规则').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Column({ space: 8 }) {
              Button({ type: ButtonType.Normal }) {
                Text(this.mode === 'global' ? '✓ 全部代理' : '全部代理').fontSize(16).width('100%')
                  .fontColor(this.mode === 'global' ? $r('app.color.accent') : $r('app.color.text_primary'));
              }.id('routingGlobal').width('100%').constraintSize({ minHeight: 48 }).padding(14).borderRadius(12)
                .backgroundColor(this.mode === 'global' ? $r('app.color.accent_soft') : $r('app.color.surface_secondary'))
                .accessibilityText('全部代理，' + (this.mode === 'global' ? '已选择' : '未选择'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.changeRoutingMode('global'); });
              Button({ type: ButtonType.Normal }) {
                Text(this.mode === 'whitelist' ? '✓ 白名单（绕过大陆）' : '白名单（绕过大陆）').fontSize(16).width('100%')
                  .fontColor(this.mode === 'whitelist' ? $r('app.color.accent') : $r('app.color.text_primary'));
              }.id('routingWhitelist').width('100%').constraintSize({ minHeight: 48 }).padding(14).borderRadius(12)
                .backgroundColor(this.mode === 'whitelist' ? $r('app.color.accent_soft') : $r('app.color.surface_secondary'))
                .accessibilityText('白名单（绕过大陆），' + (this.mode === 'whitelist' ? '已选择' : '未选择'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.changeRoutingMode('whitelist'); });
              Button({ type: ButtonType.Normal }) {
                Text(this.mode === 'rules' ? '✓ 自定义规则' : '自定义规则').fontSize(16).width('100%')
                  .fontColor(this.mode === 'rules' ? $r('app.color.accent') : $r('app.color.text_primary'));
              }.id('routingRules').width('100%').constraintSize({ minHeight: 48 }).padding(14).borderRadius(12)
                .backgroundColor(this.mode === 'rules' ? $r('app.color.accent_soft') : $r('app.color.surface_secondary'))
                .accessibilityText('自定义规则，' + (this.mode === 'rules' ? '已选择' : '未选择'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.changeRoutingMode('rules'); });
            }.width('100%');
            Text('分流只作用于上方应用范围内进入 VPN 的 IPv4 流量；IPv6 继续阻断。切换模式会保留已有的自定义规则。')
              .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            if (this.mode === 'global') {
              Text('所有进入 VPN 的流量通过当前节点，不启用白名单或自定义规则。')
                .id('routingGlobalHint').fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            }
            if (this.mode === 'whitelist') {
              Text('按 v2rayN 内置白名单分流：中国大陆及局域网条目直连，其余代理；内置例外规则优先。此模式不启用自定义列表，DNS 仍使用下方的 HTTPS DNS 设置。')
                .id('routingWhitelistHint').fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            }
            if (this.mode === 'rules') {
              Row({ space: 12 }) {
                Text('绕过局域网').layoutWeight(1).fontColor($r('app.color.text_primary'));
                Toggle({ type: ToggleType.Switch, isOn: this.bypassLan }).id('bypassLan')
                  .enabled(this.editable && !this.confirmingLeave && !this.leaving).onChange((value: boolean) => { this.bypassLan = value; this.draftChanged(); });
              }.width('100%');
              Text('每行一个域名、IPv4 地址或网段，例如 example.com、full:api.example.com、192.168.1.0/24。普通域名包含子域名。优先级：阻断 → 指定代理 → 指定直连 → 局域网。')
                .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
              Text('直连').fontColor($r('app.color.text_primary'));
              TextArea({ text: this.direct, placeholder: '需要直接访问的域名或 IPv4 网段' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('routingDirect').height(120)
                .maxLength(16384).enabled(this.editable && !this.confirmingLeave && !this.leaving).fontColor($r('app.color.text_primary'))
                .backgroundColor($r('app.color.surface_secondary')).onChange((text: string) => { this.direct = text; this.draftChanged(); });
              Text('指定代理').fontColor($r('app.color.text_primary'));
              TextArea({ text: this.proxy, placeholder: '优先通过当前节点访问' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('routingProxy').height(120)
                .maxLength(16384).enabled(this.editable && !this.confirmingLeave && !this.leaving).fontColor($r('app.color.text_primary'))
                .backgroundColor($r('app.color.surface_secondary')).onChange((text: string) => { this.proxy = text; this.draftChanged(); });
              Text('阻断').fontColor($r('app.color.text_primary'));
              TextArea({ text: this.block, placeholder: '不允许访问的域名或 IPv4 网段' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('routingBlock').height(120)
                .maxLength(16384).enabled(this.editable && !this.confirmingLeave && !this.leaving).fontColor($r('app.color.text_primary'))
                .backgroundColor($r('app.color.surface_secondary')).onChange((text: string) => { this.block = text; this.draftChanged(); });
              Text('域名规则依据可识别的 HTTP/TLS 域名匹配；无法识别域名的连接按 IP 规则处理。DNS 仍经节点发送，直连流量使用当前物理网络出口。')
                .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            }
          }.padding(18).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);
          Column({ space: 12 }) {
            Text('DNS over HTTPS').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Column({ space: 8 }) {
              Button({ type: ButtonType.Normal }) {
                Text(this.dnsMode === 'proxy' ? '✓ 全部经节点（默认）' : '全部经节点（默认）').fontSize(16).width('100%')
                  .fontColor(this.dnsMode === 'proxy' ? $r('app.color.accent') : $r('app.color.text_primary'));
              }.id('dnsModeProxy').width('100%').constraintSize({ minHeight: 48 }).padding(14).borderRadius(12)
                .backgroundColor(this.dnsMode === 'proxy' ? $r('app.color.accent_soft') : $r('app.color.surface_secondary'))
                .accessibilityText('全部经节点（默认），' + (this.dnsMode === 'proxy' ? '已选择' : '未选择'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.changeDnsMode('proxy'); });
              Button({ type: ButtonType.Normal }) {
                Text(this.dnsMode === 'split' ? '✓ 白名单 DNS 分流' : '白名单 DNS 分流').fontSize(16).width('100%')
                  .fontColor(this.dnsMode === 'split' ? $r('app.color.accent') : $r('app.color.text_primary'));
              }.id('dnsModeSplit').width('100%').constraintSize({ minHeight: 48 }).padding(14).borderRadius(12)
                .backgroundColor(this.dnsMode === 'split' ? $r('app.color.accent_soft') : $r('app.color.surface_secondary'))
                .accessibilityText('白名单 DNS 分流，' + (this.dnsMode === 'split' ? '已选择' : '未选择'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.changeDnsMode('split'); });
            }.width('100%');
            Text(this.dnsModeHint()).id('dnsModeHint').fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            Text('经节点查询的 DoH').fontSize(15).fontColor($r('app.color.text_primary'));
            TextInput({ text: this.dnsUrl, placeholder: 'https://1.1.1.1/dns-query' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('dnsUrl').maxLength(2048)
              .enabled(this.editable && !this.confirmingLeave && !this.leaving).fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.surface_secondary'))
              .onChange((text: string) => { this.dnsUrl = text; this.draftChanged(); });
            Text('支持域名或 IPv4 的 HTTPS URL；URL 中的域名交给远端节点解析。')
              .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            Button('填入默认代理 DNS').id('resetDns').constraintSize({ minHeight: 44, maxWidth: '100%' })
              .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.resetDnsUrl(false); });
            if (this.dnsMode === 'split' || this.directDnsUrl !== 'https://223.5.5.5/dns-query') {
              Text('直接查询的 DoH').fontSize(15).fontColor($r('app.color.text_primary'));
              if (this.dnsMode !== 'split' || this.mode !== 'whitelist') {
                Text('直连地址当前不生效，保留以供白名单 DNS 分流使用；保存前仍会检查地址格式。')
                  .id('directDnsInactiveHint').fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
              }
              TextInput({ text: this.directDnsUrl, placeholder: 'https://223.5.5.5/dns-query' })
                .enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('directDnsUrl').maxLength(2048)
                .enabled(this.editable && !this.confirmingLeave && !this.leaving)
                .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.surface_secondary'))
                .onChange((text: string) => { this.directDnsUrl = text; this.draftChanged(); });
              Text('仅支持 HTTPS IPv4 地址及路径，避免查询 DNS 服务器本身时形成循环。默认使用阿里公共 DNS（223.5.5.5）；直连查询通过当前物理网络发送，提供方可见查询域名和你的网络出口。公共 DNS 不保证能解析局域网私有域名。')
                .id('directDnsHint').fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
              Button('填入默认直连 DNS').id('resetDirectDns').constraintSize({ minHeight: 44, maxWidth: '100%' })
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.resetDnsUrl(true); });
              Text('DNS 按域名类别选择查询路径；仅命中 IP 分流的连接不一定使用直连 DNS。查询失败时不会改用另一条 DNS 路径。')
                .id('dnsSplitFailureHint').fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            }
            Text('节点检测使用独立的默认 DNS 和全部代理配置，不使用此处的 DNS 分流。')
              .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
          }.padding(18).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);
        }.padding({ left: 20, right: 20, bottom: 28 }).width(formContentWidth(this.windowWidthVp)).alignItems(HorizontalAlign.Start);
      }.id('networkSettingsScroll').layoutWeight(1).width('100%').align(Alignment.Top);
      Column({ space: 10 }) {
        if (this.message) { Text(this.message).id('networkSettingsResult').fontSize(14).fontColor($r('app.color.text_secondary')).width('100%'); }
        Text(this.dirty ? '有未保存的修改' : '保存后，下次连接时生效').id('networkSettingsDirtyState')
          .fontSize(13).fontColor(this.dirty ? $r('app.color.warning') : $r('app.color.text_secondary'));
        Button('保存网络设置').id('saveNetworkSettings').width('100%').constraintSize({ minHeight: 48 })
          .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
          .enabled(this.editable && (this.dirty || this.needsRepair) && !this.confirmingLeave && !this.leaving)
          .onClick(() => { this.save(); });
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, top: 12, bottom: 16 })
        .alignItems(HorizontalAlign.Start)
        .background($r('app.color.surface'), { ignoresLayoutSafeAreaEdges: [LayoutSafeAreaEdge.BOTTOM] });
    }.width('100%').height('100%').alignItems(HorizontalAlign.Center).background($r('app.color.page_bg'));
  }
}
