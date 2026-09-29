// 从衣柜现有 Demo 导入真实 ZIP，检查动作、四方向和两套装束，并保存角色总览。
async (page) => {
  const root = 'F:/Documents/ChatGPT/goalhub/data/assets/universal-lpc/starmow-20260929';
  const ids = ['scout', 'vanguard', 'engineer', 'sentinel', 'arcanist', 'ranger', 'raider', 'medic'];
  const cards = [];
  for (const id of ids) {
    await page.locator('#bundle-file').setInputFiles(`${root}/${id}.zip`);
    await page.locator('#demo-status').filter({ hasText: '已读取' }).waitFor();
    await page.locator('#demo-frame').waitFor({ state: 'visible' });
    const frame = await (await page.locator('#demo-frame').elementHandle()).contentFrame();
    if (!frame) throw new Error(`${id} 缺少预览`);
    const shots = [];
    for (const look of ['outfit-1', 'outfit-2']) {
      await frame.locator('#look').selectOption(look);
      await frame.waitForFunction(() => document.querySelector('#actor').dataset.ready === 'true');
      await frame.locator('#animation').selectOption('walk');
      // 检查四个方向均绘制了非透明像素，避免存在配置却没有实际图像。
      for (const direction of ['0', '1', '2', '3']) {
        await frame.locator('#direction').selectOption(direction);
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const visible = await frame.evaluate(() => {
          const canvas = document.querySelector('#actor');
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          return pixels.some((value, index) => index % 4 === 3 && value > 0);
        });
        if (!visible) throw new Error(`${id}/${look}/${direction} 为空`);
        if (direction === '2') shots.push(await frame.locator('#actor').evaluate(canvas => canvas.toDataURL()));
      }
      const before = await frame.locator('#actor').getAttribute('data-frame');
      await frame.waitForFunction(before => document.querySelector('#actor').dataset.frame !== before, before);
    }
    cards.push({ id, name: (await page.locator('#demo-status').textContent()).split('：')[0].replace('已读取 ', ''), shots });
  }
  await page.setViewportSize({ width: 1440, height: 660 });
  await page.setContent(`<html lang="zh-CN"><meta charset="utf-8"><style>body{background:#111823;color:#e8eef5;font:16px system-ui;margin:36px}h1{font-size:28px}p{color:#9fb0c5}main{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}section{background:#1b2635;border:1px solid #344256;padding:18px;border-radius:12px}h2{font-size:18px;margin:0 0 8px}.looks{display:flex}img{width:50%;image-rendering:pixelated}small{color:#9fb0c5}</style><h1>星球割草 · LPC 角色资源</h1><p>本地优化版衣柜导出 · 8 个角色 / 16 套装束 · 左：游戏用无武器版　右：持武器展示版</p><main>${cards.map(card => `<section><h2>${card.name}</h2><div class="looks">${card.shots.map(src => `<img src="${src}">`).join('')}</div><small>${card.id} · 四方向行走已检查</small></section>`).join('')}</main></html>`);
  await page.screenshot({ path: `${root}/preview.png`, fullPage: true });
  return { characters: cards.length, looks: cards.length * 2, directionsChecked: cards.length * 8, animationPlayback: 'passed', screenshot: `${root}/preview.png` };
}
