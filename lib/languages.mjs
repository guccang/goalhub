// 本文件统一项目默认语言、员工母语及实际执行语言的解析。
export const languages = { 'zh-CN': '中文', en: 'English', ja: '日本語', ko: '한국어' };
// validateLanguage 拒绝不支持的语言，员工可以留空表示继承。
export function validateLanguage(value, inherit = false) {
  if (inherit && (value === undefined || value === '')) return '';
  if (!Object.hasOwn(languages, value)) throw new Error('不支持的语言配置');
  return value;
}
// effectiveLanguage 为旧项目提供中文默认值，员工设置优先于项目设置。
export function effectiveLanguage(project, employee = {}) { return employee.nativeLanguage || project.settings.language || 'zh-CN'; }
// languageInstruction 限定自然语言输出，不改变机器协议和用户指定的交付语言。
export function languageInstruction(language, projectLanguage) {
  return `\n\n语言配置：项目默认语言为 ${languages[projectLanguage]} (${projectLanguage})；当前员工的工作交流语言为 ${languages[language]} (${language})。请使用当前员工的工作交流语言撰写说明、总结、提问和进度消息。目标未指定时，产品文案和交付文档使用项目默认语言；用户明确要求的交付语言优先。JSON 字段名、状态枚举、代码标识符、路径和命令保持输出协议要求，不要翻译。`;
}
