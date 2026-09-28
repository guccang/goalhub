// 本文件将保留上游来源的完整办公室构建成浏览器模块，无需 Electron 或外部 CDN。
import { build } from 'esbuild';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await build({ entryPoints: ['office-engine/entry.tsx'], outfile: 'public/office-engine/engine.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, jsx: 'automatic', legalComments: 'linked', assetNames: 'assets/[name]-[hash]', publicPath: '/office-engine',
  loader: { '.png': 'file', '.tmj': 'text' },
  alias: { '@/store/store': resolve('office-engine/store.ts'), '@/design/tokens': resolve('office-engine/upstream/design/tokens.ts'), '@/assets': resolve('office-engine/upstream/assets'), '@goalhub/bridge': resolve('office-engine/bridge.ts'), 'react-i18next': resolve('office-engine/translation.ts') },
  define: { 'process.env.NODE_ENV': '"production"' },
});

// 将素材与源码许可随场景一起提供，避免把第三方素材误标为 MIT。
await copyFile('office-engine/upstream/assets/tilesets/LIMEZUASSETS-LICENSE.txt', 'public/office-engine/ASSET-LICENSE.txt');
await copyFile('office-engine/LICENSE', 'public/office-engine/LICENSE.txt');

// 汇总构建中运行依赖的版权与许可证，随浏览器产物保留。
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [];
for (const [directory, info] of Object.entries(lock.packages)) {
  if (!directory || info.dev) continue;
  const names = await readdir(directory);
  const license = names.find(name => /^licen[sc]e(?:\.|$)/i.test(name));
  if (license) notices.push(`${directory}\n${await readFile(`${directory}/${license}`, 'utf8')}`);
}
await writeFile('public/office-engine/THIRD-PARTY-LICENSES.txt', notices.join('\n\n'));
