import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../plugins/marketplace.json', import.meta.url);
const catalog = JSON.parse(await readFile(file, 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../plugins/official/kiki-media/kimi.plugin.json', import.meta.url), 'utf8'));
const retired = new Set(manifest['x-kiki'].mediaSources.map((source) => source.legacyPluginId));
catalog.plugins = catalog.plugins.filter((entry) => !retired.has(entry.id));
const entry = catalog.plugins.find((item) => item.id === manifest.name);
entry.version = manifest.version;
entry.license = 'MIT AND Apache-2.0';
entry.description = 'One media plugin with OpenAI, Google, Ark, xAI, MiniMax, StepFun, Novita, Agnes, NewAPI and ComfyUI sources. Configure or disable each service inside Media, or add your own local script. Requires a Kiki host with grouped media sources and script-source management. Cloud generation requires media API access and can incur charges.';
entry.keywords = ['media', 'image', 'video', 'speech', 'tts', 'scripts', ...manifest['x-kiki'].mediaSources.map((source) => source.id)];
entry.localizations.zh.description = '一个媒体插件，内置 OpenAI、Google、Ark、xAI、MiniMax、StepFun、Novita、Agnes、NewAPI 和 ComfyUI 来源。可在媒体页分别配置、启停或移除，也可添加自己的本地脚本。需要支持媒体来源分组及脚本来源管理的 Kiki 宿主。云端生成需媒体 API 权限，并可能产生费用。';
entry.localizations.zh.keywords = ['媒体', '图像', '视频', '语音', '脚本', ...manifest['x-kiki'].mediaSources.map((source) => source.id)];
const expected = JSON.stringify(catalog, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== expected) throw new Error('Unified media catalog is stale');
} else await writeFile(file, expected);
