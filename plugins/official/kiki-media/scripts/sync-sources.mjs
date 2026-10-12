import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const target = new URL('../', import.meta.url);
const vendors = ['openai', 'google', 'ark', 'xai', 'minimax', 'stepfun', 'novita', 'agnes', 'newapi', 'comfyui'];
const manifest = JSON.parse(await readFile(new URL('kimi.plugin.json', target), 'utf8'));
const properties = Object.fromEntries(Object.entries(manifest['x-kiki'].settings.schema.properties).filter(([key]) => key.startsWith('default')));
const providers = [];
const sources = [];
async function output(url, content) {
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== content) throw new Error(`Unified media source drift: ${url}`);
  } else { await mkdir(new URL('./', url), { recursive: true }); await writeFile(url, content); }
}
/* The unified manifest is the only place a reader sees the media family's
 * settings text, and it is read in two languages. Provider manifests stay
 * English: each property's own English string is the key below, and a string
 * missing here keeps its English spelling rather than inventing a translation.
 * Translated text rides as `localizations.zh` — the same per-language shape the
 * host resolves field by field, falling back to the string beside it. */
const ZH_TEXT = {
  'Default image provider': '默认图像来源',
  'Default video provider': '默认视频来源',
  'Default speech provider': '默认语音来源',
  'Custom media scripts': '自定义媒体脚本',
  'Enabled': '启用',
  'Removed': '已移除',
  'Kiki connection (optional)': 'Kiki 连接（可选）',
  'API key': 'API 密钥',
  'API base URL': 'API 基础地址',
  'Default image model': '默认图像模型',
  'Default speech model': '默认语音模型',
  'Kiki Google connection (optional)': 'Kiki Google 连接（可选）',
  'Default Veo model': '默认 Veo 模型',
  'Kiki Ark connection (optional)': 'Kiki Ark 连接（可选）',
  'Ark API base URL': 'Ark API 基础地址',
  'Default Seedream model': '默认 Seedream 模型',
  'Seedance 2.0 model or endpoint ID': 'Seedance 2.0 模型或端点 ID',
  'Kiki xAI API connection (optional)': 'Kiki xAI API 连接（可选）',
  'Default video model': '默认视频模型',
  'Kiki MiniMax connection (optional)': 'Kiki MiniMax 连接（可选）',
  'API base URL (no /v1 or /v2 suffix)': 'API 基础地址（不带 /v1 或 /v2 后缀）',
  'Kiki StepFun connection (optional)': 'Kiki StepFun 连接（可选）',
  'Kiki compatible endpoint connection (optional)': 'Kiki 兼容端点连接（可选）',
  'Endpoint API key': '端点 API 密钥',
  'Compatible API base URL': '兼容 API 基础地址',
  'Actual endpoint model': '实际端点模型',
  'Kiki Agnes endpoint connection (optional)': 'Kiki Agnes 端点连接（可选）',
  'Kiki gateway connection (optional)': 'Kiki 网关连接（可选）',
  'Gateway API key': '网关 API 密钥',
  'Actual gateway model': '实际网关模型',
  'Kiki ComfyUI endpoint connection (optional)': 'Kiki ComfyUI 端点连接（可选）',
  'Your ComfyUI endpoint': '你的 ComfyUI 端点',
  'Optional endpoint API key': '可选的端点 API 密钥',
  "Use a media-capable API connection. Selected endpoint and authentication replace this plugin's key; OAuth login alone does not imply image or speech entitlement.":
    '使用支持媒体的 API 连接。所选端点与认证会替代本插件的密钥；仅登录 OAuth 并不代表拥有图像或语音权限。',
  'Use a Gemini API endpoint with x-goog-api-key authentication. Other OAuth products are not assumed compatible.':
    '使用以 x-goog-api-key 认证的 Gemini API 端点。其他 OAuth 产品不视为兼容。',
  "Selected Ark API endpoint and authentication replace this plugin's key; use an endpoint with media entitlement.":
    '所选 Ark API 端点与认证会替代本插件的密钥；请使用具备媒体权限的端点。',
  'Use your actual Seedance 2.0 model/endpoint. 2.5 is not this protocol profile.':
    '填写你实际使用的 Seedance 2.0 模型/端点。2.5 不属于此协议配置。',
  'Use an xAI media API connection; Grok web/OAuth subscriptions are not assumed to support this API.':
    '使用 xAI 媒体 API 连接；Grok 网页版/OAuth 订阅不视为支持此 API。',
  "Selected MiniMax API authentication replaces this plugin's key. Media requires corresponding pay-as-you-go entitlement; text Token Plan/OAuth does not imply it.":
    '所选 MiniMax API 认证会替代本插件的密钥。媒体功能需要相应的按量付费权限；文本 Token Plan/OAuth 不代表拥有该权限。',
  "Selected StepFun API endpoint and authentication replace this plugin's key; choose an endpoint with TTS entitlement.":
    '所选 StepFun API 端点与认证会替代本插件的密钥；请选择具备语音合成权限的端点。',
  "Selected endpoint and authentication replace this plugin's own configuration; endpoint must implement this video profile.":
    '所选端点与认证会替代本插件自身的配置；端点需实现此视频协议配置。',
  "Selected endpoint and authentication replace this plugin's own configuration; endpoint must implement Agnes video.":
    '所选端点与认证会替代本插件自身的配置；端点需实现 Agnes 视频。',
  "Selected gateway endpoint and authentication replace this plugin's own configuration; model availability remains endpoint-specific.":
    '所选网关端点与认证会替代本插件自身的配置；模型可用性仍取决于具体端点。',
  'Optional endpoint/custom-header connection; otherwise use your local ComfyUI URL without authentication.':
    '可选的端点/自定义请求头连接；否则直接使用本地 ComfyUI 地址，无需认证。',
};
/* A group heading is a brand plus a category word: the brand keeps its own
 * spelling, the category reads in the reader's language, and it stays true to
 * what that source actually offers. */
const ZH_GROUPS = {
  openai: 'OpenAI 媒体',
  google: 'Google 媒体',
  ark: 'Ark 媒体',
  xai: 'xAI 媒体',
  minimax: 'MiniMax 媒体',
  stepfun: 'StepFun 语音',
  novita: 'Novita 视频',
  agnes: 'Agnes 视频',
  newapi: 'NewAPI 视频',
  comfyui: 'ComfyUI 工作流',
};
/* One language's text for a property. `localizations` is rebuilt from the
 * table each run, so regenerating never accumulates stale translations. */
function localized(property, groupTitle) {
  const base = { ...property };
  delete base.localizations;
  const zh = {};
  if (ZH_TEXT[property.title] !== undefined) zh.title = ZH_TEXT[property.title];
  if (ZH_TEXT[property.description] !== undefined) zh.description = ZH_TEXT[property.description];
  if (groupTitle !== undefined) zh.groupTitle = groupTitle;
  return Object.keys(zh).length === 0 ? base : { ...base, localizations: { zh } };
}
for (const vendor of vendors) {
  const donor = new URL(`kiki-media-${vendor}/`, root);
  const original = JSON.parse(await readFile(new URL('kimi.plugin.json', donor), 'utf8'));
  const prefix = `${vendor}__`;
  const label = original.interface.displayName;
  const groupTitle = ZH_GROUPS[vendor];
  for (const [key, property] of Object.entries(original['x-kiki'].settings.schema.properties)) {
    properties[prefix + key] = localized({ ...property, group: vendor, groupTitle: label }, groupTitle);
  }
  properties[prefix + 'enabled'] = localized({ type: 'boolean', default: true, title: 'Enabled', group: vendor, groupTitle: label }, groupTitle);
  properties[prefix + 'removed'] = localized({ type: 'boolean', default: false, hidden: true, title: 'Removed', group: vendor, groupTitle: label }, groupTitle);
  properties[prefix + 'cleared'] = localized({ type: 'string', default: '[]', hidden: true, group: vendor, groupTitle: label }, groupTitle);
  sources.push({ id: vendor, label: original.interface.displayName, providerIds: original['x-kiki'].mediaProviders.map((definition) => `${vendor}-${definition.id}`), settingsPrefix: prefix, legacyPluginId: original.name, required: original['x-kiki'].settings.schema.required ?? [] });
  for (const definition of original['x-kiki'].mediaProviders) providers.push({ ...definition, id: `${vendor}-${definition.id}`, connectionSetting: prefix + definition.connectionSetting });
  await output(new URL(`lib/sources/${vendor}.mjs`, target), (await readFile(new URL('adapters.mjs', donor), 'utf8')).replace("'./runtime.mjs'", "'../runtime.mjs'"));
}
await output(new URL('lib/runtime.mjs', target), await readFile(new URL('media-runtime/runtime.mjs', root), 'utf8'));
providers.push({ schemaVersion: 1, id: 'custom-script', label: 'Custom script', kinds: ['image', 'video', 'tts'], resumeVersion: 1 });
const idsFor = (kind) => providers.filter((item) => item.kinds?.includes(kind)).map((item) => item.id);
for (const [key, kind] of [['defaultImageProvider', 'image'], ['defaultVideoProvider', 'video'], ['defaultTtsProvider', 'tts']]) {
  if (properties[key]) properties[key] = localized({ ...properties[key], enum: idsFor(kind) });
}
properties.scriptSources = localized({ type: 'string', default: '[]', title: 'Custom media scripts', multiline: true, advanced: true });
manifest.version = '0.2.1';
manifest['x-kiki'].mediaProviders = providers;
manifest['x-kiki'].mediaSources = sources;
manifest['x-kiki'].mediaScriptProvider = 'custom-script';
manifest['x-kiki'].settings.schema.properties = properties;
manifest['x-kiki'].permissions.secrets = true;
manifest['x-kiki'].permissions.exec = ['*'];
manifest['x-kiki'].permissions.uiPanel = true;
manifest['x-kiki'].panels = [{ schemaVersion: 1, id: 'settings', label: 'Settings', slot: 'settings', path: './settings.html' }];
await output(new URL('kimi.plugin.json', target), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Unified ${sources.length} sources / ${providers.length - 1} adapters`);
