// 本文件从固定版本的 Munder Difflin 提取 MIT 程序化角色，去除 TypeScript 类型以供浏览器原生加载。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';

const commit = '91015c0e1316572fe1c771ae3ece162ae0bd92c6';
const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error('用法：node scripts/vendor-munder.mjs <上游 Git 仓库路径>');
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
if (actual !== commit) throw new Error(`上游版本必须固定为 ${commit}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'public', 'vendor', 'munder-difflin');
mkdirSync(output, { recursive: true });
const sourcePath = 'src/renderer/src/scene/office/portraitArt.ts';
const source = readFileSync(join(sourceRoot, sourcePath), 'utf8');
let javascript = stripTypeScriptTypes(source, { mode: 'strip' });
javascript = javascript.replace(/^(export )?function (\w+)\(/gm, '// $2 根据上游角色配方处理像素、轮廓或动画帧。\n$1function $2(');
javascript = javascript.replace(/^const (clamp|style\w+)\s*=/gm, '// $1 执行角色颜色或发型的像素绘制。\nconst $1 =');
const header = `// 本文件是上游 MIT 程序化像素角色的浏览器版本；只移除类型并补充中文注释。\n// Copyright (c) 2026 Chaitanya Giri. MIT License，见同目录 LICENSE.txt。\n// 上游固定提交：${commit}；使用 scripts/vendor-munder.mjs 重新生成。\n`;
writeFileSync(join(output, 'portrait-art.js'), header + javascript);
writeFileSync(join(output, 'LICENSE.txt'), readFileSync(join(sourceRoot, 'LICENSE'), 'utf8'));
writeFileSync(join(output, 'UPSTREAM.json'), JSON.stringify({ repository: 'https://github.com/chaitanyagiri/munder-difflin', commit, source: sourcePath, sourceSha256: createHash('sha256').update(source).digest('hex'), license: 'MIT', modifications: ['移除 TypeScript 类型', '添加中文函数注释'], assets: '仅使用程序化生成角色，未包含 LimeZu 贴图、地图或字体' }, null, 2) + '\n');
console.log(`已生成 ${join(output, 'portrait-art.js')}`);
