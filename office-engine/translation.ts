// 本文件提供原办公室中文词条，沿用上游插值规则，无需初始化整套桌面应用。
import messages from './zh-CN.json';
// translate 从中文资源中查找键，并替换场景活动使用的模板参数。
function translate(key: string, options: Record<string, unknown> = {}) {
  const value = key.split('.').reduce<any>((object, name) => object?.[name], messages);
  return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
}
const translation = { t: translate, i18n: { language: 'zh-CN' } };
// useTranslation 为上游组件返回稳定的中文翻译对象。
export function useTranslation() { return translation; }
