// 本文件在说话时按员工语言解析内置台词，不翻译真实任务输出。
import messages from './speech.json' with { type: 'json' };
const prefix = '@goalhub-speech:';
// speechToken 保存语义键和插值，双方交谈可以分别使用自己的母语。
export function speechToken(key: string, options: Record<string, unknown> = {}): string { return prefix + JSON.stringify([key, options]); }
// renderSpeech 仅解析内置台词标记，动态工作内容原样保留。
export function renderSpeech(text: string, language = 'zh-CN'): string {
  if (!text.startsWith(prefix)) return text;
  const [key, options] = JSON.parse(text.slice(prefix.length));
  const locale = (messages as any)[language] || messages['zh-CN'];
  const value = key.replace(/^office\./, '').split('.').reduce((obj: any, part: string) => obj?.[part], locale);
  return String(value ?? '').replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? (name === 'godName' ? ({ en: 'Boss', ja: '上司', ko: '상사', 'zh-CN': '老板' } as any)[language] || '老板' : '')));
}
