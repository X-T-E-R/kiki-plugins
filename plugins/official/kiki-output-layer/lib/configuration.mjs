export const defaultPresets = [
  { id: 'translate', label: '翻译', instruction: '将原文翻译为简体中文。保留 Markdown、代码、专有名词与原意，只输出译文。', contextWindow: 32768, maxOutputTokens: 2048 },
  { id: 'plain', label: '说人话', instruction: '用清楚自然的中文改写原文，删去空话，保留事实、数字、条件和 Markdown。只输出改写后的正文。', contextWindow: 32768, maxOutputTokens: 2048 },
  { id: 'custom', label: '自定义', instruction: '保留原意，将原文改写得简洁清晰。只输出改写后的正文。', contextWindow: 32768, maxOutputTokens: 2048 },
];

export function configuration(settings = {}) {
  const presets = settings.presets ? JSON.parse(settings.presets) : structuredClone(defaultPresets);
  if (!Array.isArray(presets) || presets.some((preset) => !preset.id || !preset.label || !preset.instruction)) throw new Error('预设必须包含 id、名称和提示词');
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length) throw new Error('预设 id 不能重复');
  return {
    enabled: true, presets,
    settings: {
      groupChars: settings.groupChars ?? 600,
      preloadBefore: settings.preloadBefore ?? 1,
      preloadAfter: settings.preloadAfter ?? 1,
      historyTokens: settings.historyTokens ?? 16384,
    },
  };
}
