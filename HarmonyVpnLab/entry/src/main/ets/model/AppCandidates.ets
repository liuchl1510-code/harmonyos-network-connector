export class AppCandidate {
  bundleName: string;
  name: string;
  constructor(bundleName: string, name: string) {
    this.bundleName = bundleName;
    this.name = name;
  }
}

// A bounded set of candidates, never a claim about what is installed.
// The first six names were verified by exact package queries on a development phone
// on 2026-09-15. They are hints, not a promise for every app version or device.
// Huawei names are from its HarmonyOS 5+ theme-engine package list, checked 2026-09-15:
// https://developer.huawei.com/consumer/cn/doc/content/themes-engine-next-base-intentcommand-0000002471235064
// Ordinary third-party apps cannot query other bundles with the normal permission.
// These are user-selectable presets only; installation status is never inferred.
export const COMMON_APP_CANDIDATES: AppCandidate[] = [
  new AppCandidate('com.tencent.wechat', '微信'),
  new AppCandidate('com.ss.hm.ugc.aweme', '抖音'),
  new AppCandidate('com.tencent.mqq', 'QQ'),
  new AppCandidate('com.alipay.mobile.client', '支付宝'),
  new AppCandidate('com.sankuai.hmeituan', '美团'),
  new AppCandidate('com.jd.hm.mall', '京东'),
  new AppCandidate('com.huawei.hmos.browser', '华为浏览器'),
  new AppCandidate('com.huawei.hmsapp.appgallery', '华为应用市场'),
  new AppCandidate('com.huawei.hmsapp.himovie', '华为视频'),
  new AppCandidate('com.huawei.hmsapp.music', '华为音乐'),
  new AppCandidate('com.huawei.hmsapp.books', '华为阅读'),
  new AppCandidate('com.huawei.hmos.clouddrive', '云空间'),
  new AppCandidate('com.huawei.hmos.meetime', '畅连'),
  new AppCandidate('com.huawei.hmos.wallet', '华为钱包')
];
