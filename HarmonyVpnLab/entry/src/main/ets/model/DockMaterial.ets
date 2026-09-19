import { deviceInfo } from '@kit.BasicServicesKit';

export class DockMaterialState {
  available: boolean = false;
  reason: string = 'unavailable';
  capsule: SystemUiMaterial | undefined = undefined;
  action: SystemUiMaterial | undefined = undefined;
}

let materialLoad: Promise<DockMaterialState> | undefined = undefined;

async function createDockMaterial(): Promise<DockMaterialState> {
  const result = new DockMaterialState();
  // Do not statically load the API 26 native module on API 24/25. The global
  // SystemUiMaterial name is an SDK type alias, erased from the emitted code.
  if (!Number.isSafeInteger(deviceInfo.sdkApiVersion) || deviceInfo.sdkApiVersion < 26) {
    result.reason = 'older-api'; return result;
  }
  try {
    const loaded = await import('@ohos.arkui.uiMaterial');
    if (!loaded.default.isImmersiveMaterialSupported()) { result.reason = 'unsupported-device'; return result; }
    if (loaded.default.getMaterialInfo().state === loaded.default.MaterialState.DISABLE) {
      result.reason = 'disabled-configuration'; return result;
    }
    const capsule = new loaded.default.ImmersiveMaterial({
      style: loaded.default.ImmersiveStyle.ULTRA_THIN,
      materialColor: Color.Transparent,
      colorInvert: false,
      applyShadow: true,
      interactive: false
    });
    const action = new loaded.default.ImmersiveMaterial({
      style: loaded.default.ImmersiveStyle.ULTRA_THIN,
      materialColor: Color.Transparent,
      colorInvert: false,
      applyShadow: true,
      interactive: true,
      lightEffect: { color: Color.White }
    });
    result.capsule = capsule; result.action = action;
    result.available = true; result.reason = 'system-material';
    return result;
  } catch (_) {
    // Capability/module failures must never prevent navigation or VPN control.
    // The caller uses the API 24 background-effect fallback in this case.
    result.reason = 'unavailable'; return result;
  }
}

// Load once per UI process, sharing a single asynchronous capability query.
// Availability is not proof of rendering: on target API 26 the components must
// also be hosted in a supported Navigation title or bottom Tabs bar context.
// Callers must conditionally invoke systemMaterial only when available; invoking
// systemMaterial(undefined) on an older OS still calls an unsupported API.
export function loadDockMaterial(): Promise<DockMaterialState> {
  if (!materialLoad) { materialLoad = createDockMaterial(); }
  return materialLoad;
}

// Attach to the rounded Row/Button within GlassDockLayout's actual TabBar.
// Rounded geometry and the foreground icons/labels remain the caller's concern.
export class DockGlassModifier implements AttributeModifier<CommonAttribute> {
  private material: SystemUiMaterial | undefined;

  constructor(material: SystemUiMaterial | undefined = undefined) { this.material = material; }

  applyNormalAttribute(instance: CommonAttribute): void {
    instance.backgroundColor(Color.Transparent);
    if (deviceInfo.sdkApiVersion >= 26 && this.material !== undefined) {
      // The first render can use fallback blur while the module loads. Remove
      // every conflicting fallback layer before applying the system material.
      instance.backgroundEffect(undefined);
      instance.borderWidth(0);
      instance.shadow({ radius: 0, color: Color.Transparent });
      instance.systemMaterial(this.material);
      return;
    }
    // All fallback attributes below predate the minimum supported API 24.
    // Never call systemMaterial(undefined) to clear state on an older OS.
    instance.backgroundEffect({ radius: 20, saturation: 1.15, brightness: 1,
      color: $r('app.color.dock_glass_tint') });
    instance.border({ width: 0.6, color: $r('app.color.dock_glass_edge') });
    instance.shadow({ radius: 16, color: '#18000000', offsetY: 4 });
  }
}
