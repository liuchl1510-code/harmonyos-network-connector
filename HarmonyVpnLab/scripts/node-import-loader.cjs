// Desktop-only loader for the authored ArkTS parser. This substitutes Node APIs
// for the SDK URL/Base64/TextDecoder APIs; it is not a HarmonyOS runtime test.
const fs = require('fs');
const path = require('path');
const Module = require('module');

function loadNodeParser(typescriptDir) {
    const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
    const ts = require(typescriptDir || path.join(devEco,
        'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
    const file = path.resolve(__dirname, '../entry/src/main/ets/model/NodeImport.ets');
    const importLine = "import { url, util } from '@kit.ArkTS';";
    const original = fs.readFileSync(file, 'utf8');
    if (!original.includes(importLine)) throw new Error('PARSER_IMPORT_CHANGED');
    const shim = `
const url = { URL: { parseURL: (s: string): URL => new URL(s) } };
const util = {
    Base64Helper: class { decodeSync(s: string): Uint8Array { return Buffer.from(s, 'base64'); } },
    TextDecoder: { create: (s: string, options: Object): Object => ({
        decodeToString: (data: Uint8Array): string => new TextDecoder(s, options).decode(data)
    }) }
};`;
    const output = ts.transpileModule(original.replace(importLine, shim), {
        compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
        reportDiagnostics: true
    });
    if (output.diagnostics.length !== 0) throw new Error('PARSER_TRANSPILE_FAILED');
    const loaded = new Module(file);
    loaded._compile(output.outputText, file);
    return loaded.exports.parseNode;
}

module.exports = { loadNodeParser };
