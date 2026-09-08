interface ErrorFields { code?: number; message?: string; }

// Diagnostic errors must not serialize configuration objects or credentials.
export function describeError(error: Object): string {
  const fields = error as ErrorFields;
  const code = typeof fields.code === 'number' ? fields.code : 0;
  let message = typeof fields.message === 'string' ? fields.message : String(error);
  if (code === 2300028) { message = 'HTTP 请求超时'; }
  if (code === 2300007) { message = '无法建立 HTTP 连接'; }
  if (code === 2300060) { message = 'HTTPS 证书验证失败'; }
  message = message.replace(/(?:vless|vmess|trojan|ss):\/\/\S+/gi, '[node-link]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]');
  if (message.includes('"password"') || message.includes('"privateKey"') || message.includes('"outbounds"')) {
    message = '配置或协议错误，详细内容不写入日志';
  }
  return (code === 0 ? '' : `code=${code} `) + message.slice(0, 240);
}
