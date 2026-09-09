import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';

// Loaded only after the caller verifies the system ScanBarcode capability.
// Preserve the phone scanner's QR-only, single-result and album flow.
export async function scanNodeCode(context: common.UIAbilityContext): Promise<string> {
  const result = await scanBarcode.startScanForResult(context, {
    scanTypes: [scanCore.ScanType.QR_CODE], enableMultiMode: false, enableAlbum: true
  });
  return result.originalValue;
}
