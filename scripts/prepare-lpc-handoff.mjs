// 校验本地衣柜导出的角色包，整理稳定资源路径、动作索引和可离线查看的预览。
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const [inputArg, outputArg, sourceArg = 'F:/Documents/ChatGPT/Universal-LPC'] = process.argv.slice(2);
if (!inputArg || !outputArg) throw new Error('用法：node scripts/prepare-lpc-handoff.mjs <ZIP目录> <资源目录> [Universal-LPC目录]');
const input = resolve(inputArg), output = resolve(outputArg), source = resolve(sourceArg);
const JSZip = createRequire(join(source, 'package.json'))('jszip');
const ids = ['scout', 'vanguard', 'engineer', 'sentinel', 'arcanist', 'ranger', 'raider', 'medic'];
const index = { version: 1, sourceRoot: source, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), generatorUrl: 'http://127.0.0.1:5173/wardrobe.html', characters: [] };
await mkdir(output, { recursive: true });
for (const id of ids) {
  const zip = await JSZip.loadAsync(await readFile(join(input, `${id}.zip`)));
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  if (manifest.format !== 'lpc-wardrobe' || manifest.frameSize !== 64 || manifest.sheetWidth !== 832 || manifest.sheetHeight !== 3456 || manifest.outfits.length !== 2 || !manifest.credits.length) throw new Error(`${id} 的格式、尺寸、装束或署名不完整`);
  if (JSON.stringify(manifest.directions) !== JSON.stringify(['up', 'left', 'down', 'right'])) throw new Error(`${id} 的朝向顺序不符合当前协议`);
  for (const file of [...manifest.assets.map(asset => asset.file), manifest.base.composite, ...manifest.outfits.map(look => look.composite)]) {
    const data = await zip.file(file)?.async('nodebuffer');
    if (!data || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || data.readUInt32BE(16) !== 832 || data.readUInt32BE(20) !== 3456) throw new Error(`${id}/${file} PNG 无效`);
  }
  for (const look of manifest.outfits) {
    if (!['walk', 'idle'].every(action => look.animations.includes(action))) throw new Error(`${id}/${look.id} 缺少基础动作`);
    for (const action of look.animations) {
      const animation = manifest.animations[action];
      if (!animation || animation.row + animation.num > 54 || animation.cycle.some(frame => frame < 0 || frame >= 13)) throw new Error(`${id} 动作越界：${action}`);
    }
  }
  const directory = join(output, id);
  await mkdir(directory, { recursive: true });
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const destination = resolve(directory, entry.name);
    if (!destination.startsWith(directory + sep)) throw new Error('资源包包含越界路径');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await entry.async('nodebuffer'));
  }
  await copyFile(join(input, `${id}.zip`), join(output, `${id}.zip`));
  index.characters.push({ id, name: manifest.name, bodyType: manifest.bodyType, manifest: `${id}/manifest.json`, project: `${id}/project.json`, credits: `${id}/CREDITS.txt`, frameSize: 64, sheetWidth: 832, sheetHeight: 3456, directions: manifest.directions,
    looks: manifest.outfits.map(look => ({ id: look.id, name: look.name, file: `${id}/${look.composite}`, animations: look.animations })), missingAnimations: ['hurt', 'climb'].filter(action => !manifest.outfits[0].animations.includes(action)) });
}
await writeFile(join(output, 'asset-index.json'), JSON.stringify(index, null, 2));
// 预览只裁取导出精灵图中的既有帧，不重绘或改变像素资产。
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>星球割草 · LPC 角色资源</title>
<style>body{background:#111823;color:#e8eef5;font:16px system-ui;margin:32px}h1{font-size:26px}p{color:#9fb0c5}main{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.card{background:#1b2635;border:1px solid #344256;padding:16px;border-radius:12px}h2{font-size:18px;margin:0 0 8px}canvas{width:100%;image-rendering:pixelated}small{color:#9fb0c5}</style>
<h1>星球割草 · LPC 角色资源</h1><p>本地像素衣橱导出 · 8 个角色 · 无武器 / 持武器装束 · 64×64 原始帧</p><main>${index.characters.map(c => `<section class="card"><h2>${c.name}</h2><canvas width="288" height="192" data-id="${c.id}"></canvas><small>${c.id} · ${c.bodyType}</small></section>`).join('')}</main>
<script>
// 加载两套装束，按四方向行走帧显示；无网络也能查看。
window.lpcPreviewReady=Promise.all([...document.querySelectorAll('canvas')].map(async canvas=>{
 const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
 for(let outfit=1;outfit<=2;outfit++){
  const img=new Image();img.src=canvas.dataset.id+'/outfits/outfit-'+outfit+'.png';await img.decode();
  for(let n=0;n<3;n++){const direction=[1,2,3][n];ctx.drawImage(img,64,(8+direction)*64,64,64,n*96,(outfit-1)*96,96,96);}
 }
}));
</script></html>`;
await writeFile(join(output, 'preview.html'), html);
console.log(JSON.stringify({ output, characters: index.characters.length, pngValidation: 'passed', sourceCommit: index.sourceCommit, missingAnimations: index.characters.map(c => ({ id: c.id, missing: c.missingAnimations })) }, null, 2));
