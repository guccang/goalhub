// 本文件在独立源码快照中提供无依赖静态预览，只公开网页资源并限制在回环地址。
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';

const root = await realpath(process.cwd());
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm' };

// asset 拒绝隐藏文件、内部配置、路径穿越和指向快照外的符号链接。
async function asset(path) {
  const parts = path.split(/[\\/]/);
  if (parts.some(part => part.startsWith('.') || part === 'node_modules') || path.includes('\0') || path.includes(':')) throw new Error('资源不可访问');
  const candidate = resolve(root, '.' + path);
  let file = await realpath(candidate);
  if ((await stat(file)).isDirectory()) file = await realpath(resolve(file, 'index.html'));
  const sub = relative(root, file);
  if (!sub || sub.startsWith('..') || isAbsolute(sub) || !mime[extname(file).toLowerCase()] || /(?:^|[\\/])(?:goalhub\.delivery|package(?:-lock)?)\.json$/i.test(sub)) throw new Error('资源不可访问');
  return file;
}

await asset('/index.html');
if (process.argv.includes('--check')) {
  console.log('静态网页入口验证通过，无需编译。');
} else {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效预览端口');
  // respond 仅响应读取请求，不提供目录列表或执行项目脚本。
  const server = createServer(async function respond(request, response) {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    try {
      const path = decodeURIComponent((request.url || '/').split('?')[0]);
      if (!path.startsWith('/')) throw new Error('无效路径');
      const file = await asset(path), content = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[extname(file).toLowerCase()], 'Content-Length': content.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`静态预览：http://127.0.0.1:${port}/`));
}
