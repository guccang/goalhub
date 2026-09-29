// 使用本地优化版像素衣橱导出接入样例；通过 playwright-cli run-code --filename 执行。
async (page) => {
  const characters = [
    { id: 'scout', name: '星蓝侦察兵', body: 'male', skin: 'light', color: 'blue', hair: 'hair_buzzcut', hairColor: 'brown', weapon: 'weapon_ranged_crossbow' },
    { id: 'vanguard', name: '赤铜先锋', body: 'male', skin: 'bronze', color: 'maroon', hair: 'hair_shorthawk', hairColor: 'black', weapon: 'weapon_polearm_spear', armour: 'torso_armour_leather' },
    { id: 'engineer', name: '琥珀工程师', body: 'male', skin: 'olive', color: 'orange', hair: 'hair_flat_top_fade', hairColor: 'black', weapon: 'weapon_ranged_slingshot' },
    { id: 'sentinel', name: '银甲守卫', body: 'male', skin: 'brown', color: 'white', hair: 'hair_cornrows', hairColor: 'black', weapon: 'weapon_sword_dagger', armour: 'torso_armour_plate' },
    { id: 'arcanist', name: '紫晶术士', body: 'female', skin: 'light', color: 'purple', hair: 'hair_bob', hairColor: 'white', weapon: 'weapon_magic_simple' },
    { id: 'ranger', name: '翠羽游侠', body: 'female', skin: 'amber', color: 'green', hair: 'hair_high_ponytail', hairColor: 'brown', weapon: 'weapon_ranged_crossbow' },
    { id: 'raider', name: '绯红突击手', body: 'female', skin: 'taupe', color: 'red', hair: 'hair_braid', hairColor: 'black', weapon: 'weapon_sword_dagger' },
    { id: 'medic', name: '霜白支援者', body: 'female', skin: 'black', color: 'teal', hair: 'hair_bangs_bun', hairColor: 'white', weapon: 'weapon_magic_simple' },
  ];
  const results = [];
  for (const spec of characters) {
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    // 浏览器调用衣柜原有渲染和导出模块，保留配色、图层顺序、署名及可再编辑配置。
    const result = await page.evaluate(async (spec) => {
      const { createCatalog } = await import('/sources/state/catalog.ts');
      const { loadAllMetadata } = await import('/sources/install-item-metadata.ts');
      const { itemSelection, validateProject } = await import('/sources/wardrobe/model.ts');
      const { createWardrobeRenderer } = await import('/sources/wardrobe/render.ts');
      const { exportBundle, readBundle, downloadBlob } = await import('/sources/wardrobe/bundle.ts');
      const { reader, writer } = createCatalog();
      await loadAllMetadata(writer);
      // 颜色只从素材声明的选项中选择，避免通过猜测文件路径获取不存在的变体。
      function select(id, color) {
        const meta = reader.getItemLite(id).unwrapOr(null);
        if (!meta || !meta.required.includes(spec.body)) throw new Error(`素材不兼容：${id}/${spec.body}`);
        const selection = itemSelection({ id, meta });
        const colors = meta.recolors[0]?.variants || [];
        if (color && colors.includes(color)) selection.recolor = color;
        return selection;
      }
      const base = {
        body: select('body', spec.skin), head: select(`heads_human_${spec.body}`, spec.skin),
        expression: select('face_neutral', spec.skin), hair: select(spec.hair, spec.hairColor),
      };
      const selections = {
        clothes: select('torso_clothes_longsleeve2', spec.color),
        legs: select('legs_pants', 'charcoal'), shoes: select('feet_boots_basic', 'black'),
      };
      if (spec.armour) selections.armour = select(spec.armour, spec.id === 'sentinel' ? 'silver' : 'brown');
      const project = validateProject({ version: 1, name: spec.name, bodyType: spec.body, base, outfits: [
        { id: 'outfit-1', name: '战斗用无武器装束', selections },
        { id: 'outfit-2', name: '持武器展示装束', selections: { ...selections, weapon: select(spec.weapon) } },
      ] }, reader);
      const blob = await exportBundle(reader, project, createWardrobeRenderer(reader), () => {});
      const payload = await readBundle(blob);
      for (const look of payload.manifest.outfits) {
        if (!['idle', 'walk'].every(animation => look.animations.includes(animation))) throw new Error(`动作不完整：${spec.id}/${look.id}`);
      }
      downloadBlob(blob, `${spec.id}.zip`);
      return { id: spec.id, name: spec.name, bytes: blob.size, outfits: payload.manifest.outfits.map(look => ({ id: look.id, animations: look.animations })) };
    }, spec);
    const download = await downloadPromise;
    await download.saveAs(`output/playwright/lpc-pack/${spec.id}.zip`);
    results.push(result);
  }
  return results;
}
