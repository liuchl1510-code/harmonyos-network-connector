'use strict';
// Failure metadata is an allowlist, never a command/error/output transcript.
const stages=new Set(['preflight','metrics','ui-helper','navigation','snapshot','capture','install','fixture','observation','output','unknown']);
const operations=new Set(['guest-model','guest-name','package-info','read-installation','validate-preview','validate-artifact','process-id','proc-stat','proc-status','memory-breakdown','navigate','inspect-layout','parse-helper-result','validate-helper-result','validate-process','return-home','find-control','click-control','swipe','dump-layout','read-layout','parse-layout','cleanup-layout','capture-layout','capture-image','receive-image','cleanup-image','start-app','stop-app','install-preview','read-artifact','write-installation','write-report','write-fixture','send-fixture','input-text','back-key','validate-mode','append-sample','pause','hdc-command','unknown']);
const modes=new Set(['none','baseline','idle','observation','Install','SeedCatalog','Home','Nodes','Settings','ThemeDark','ThemeSystem','Network','HomeNetwork','NodeHelp','Backup','About','Privacy','Diagnostics','Subscriptions','Import','SeedSamples','Editor','Back','Inspect','unknown']);
const codes=new Set(['HDC_TIMEOUT','HDC_OUTPUT_LIMIT','HDC_UNAVAILABLE','HDC_ACCESS_DENIED','HDC_EXIT_NONZERO','HDC_OPERATION_FAILED','HELPER_TIMEOUT','HELPER_OUTPUT_LIMIT','HELPER_UNAVAILABLE','HELPER_ACCESS_DENIED','HELPER_EXIT_NONZERO','HELPER_OPERATION_FAILED','UI_PREVIEW_REQUIRED','UI_ARTIFACT_IDENTITY_UNAVAILABLE','UI_ARTIFACT_CHANGED','UI_PROCESS_MISSING_OR_AMBIGUOUS','UI_PROC_STAT_UNAVAILABLE','UI_LAYOUT_OR_OVERFLOW_FAILURE','UI_PROCESS_RESTARTED','UI_HELPER_RESULT_INVALID','UI_BOUNDS_INVALID','UI_SYSTEM_MODAL','UI_CONTROL_AMBIGUOUS','UI_CONTROL_UNAVAILABLE','UI_CONTROL_DISABLED','UI_HOME_UNAVAILABLE','UI_APPLICATION_NOT_VISIBLE','UI_INSTALL_FAILED','UI_FIXTURE_PRECONDITION_FAILED','UI_FIXTURE_TRANSFER_FAILED','UI_FIXTURE_NOT_ACCEPTED','UI_SAMPLE_NODE_UNAVAILABLE','UI_MODE_INVALID','UI_LAYOUT_JSON_INVALID','UI_OPERATION_FAILED']);
function status(error){return Number.isSafeInteger(error?.status)?error.status:undefined;}
function sanitize(detail){
 if(!detail||typeof detail!=='object'||!codes.has(detail.errorCode))return undefined;
 const result={stage:stages.has(detail.stage)?detail.stage:'unknown',operation:operations.has(detail.operation)?detail.operation:'unknown',mode:modes.has(detail.mode)?detail.mode:'unknown',errorCode:detail.errorCode};
 if(Number.isSafeInteger(detail.exitStatus))result.exitStatus=detail.exitStatus;
 return result;
}
function detail(context,errorCode,error){return sanitize({...context,errorCode,exitStatus:status(error)});}
function command(context,error,domain='HDC'){
 const suffix=error?.code==='ETIMEDOUT'?'TIMEOUT':['ENOBUFS','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error?.code)?'OUTPUT_LIMIT':error?.code==='ENOENT'?'UNAVAILABLE':['EACCES','EPERM'].includes(error?.code)?'ACCESS_DENIED':Number.isSafeInteger(error?.status)&&error.status!==0?'EXIT_NONZERO':'OPERATION_FAILED';
 return detail(context,(domain==='HELPER'?'HELPER':'HDC')+'_'+suffix,error);
}
function failure(code,context,original){const error=Error(codes.has(code)?code:'UI_OPERATION_FAILED');error.failureDetail=detail(context,error.message,original);return error;}
function helper(stderr,mode){
 if(typeof stderr!=='string'&&!Buffer.isBuffer(stderr))return undefined;
 const text=String(stderr);if(text.length>8192)return undefined;
 const line=text.trim().split(/\r?\n/).at(-1);if(!line||line.length>2048)return undefined;
 try{const value=JSON.parse(line),safe=sanitize(value.failureDetail);return safe&&value.errorCode===safe.errorCode&&safe.mode===mode?safe:undefined;}catch(_){return undefined;}
}
module.exports={sanitize,detail,command,failure,helper};
