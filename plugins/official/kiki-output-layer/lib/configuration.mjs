export const defaultPresets = [
  {
    id: 'translate', label: '译为中文', contextWindow: 32768,
    instruction: '将输入的 Assistant 正文译为自然准确的简体中文，直接输出译文。输入可能是上下文片段，保持前后自然承接。\n- 保真要求：严格对应原文的否定、条件与例外、因果论证与时态归因；准确保持事实、推测、建议以及已完成与待办状态；数字、单位、日期、版本、专有名词与引用目标准确对应。\n- 格式保持：保持 Markdown 结构与标题层级；代码块、命令、路径、URL 与 API 标识符原样保留，仅翻译周围说明。不添加寒暄、解释或前言后语。',
  },
  {
    id: 'translate-en', label: '译为英文', contextWindow: 32768,
    instruction: 'Translate the supplied Assistant text into fluent, accurate, natural English. Return the translation directly. The input may be a fragment; preserve continuity.\n- Fidelity: Preserve negation, conditions, exceptions, causal reasoning, attribution, tense, and completed vs. proposed states. Maintain the original degree of certainty. Accurately map numbers, units, dates, versions, names, and citation targets.\n- Formatting: Keep Markdown structure intact. Keep fenced code, inline code, commands, paths, URLs, and API identifiers unchanged; translate surrounding prose. Do not add conversational filler or commentary.',
  },
  {
    id: 'plain', label: '说人话', contextWindow: 32768,
    instruction: '把输入的 Assistant 正文改写为通俗自然、重点突出的中文，直接输出改写正文。围绕读者眼前的结论、行动或结果组织，条件紧随动作，删去套话、寒暄、预告与重复归纳。\n- 保真要求：严格保留否定、条件、例外、因果逻辑与不确定性程度；保持已完成与待办状态、人物与动作关系一致；数字、单位、日期、版本与引用目标准确对应。\n- 格式保持：成组要点用列表；代码块、命令、路径与标识符原样保留，不因简化而删减关键事实。',
  },
  {
    id: 'catgirl', label: '猫娘', contextWindow: 32768,
    instruction: '把输入的 Assistant 正文改写为轻快亲昵聪明的猫娘语气（句末自然带‘喵’，可称读者为‘主人’），直接输出改写正文。语气服务正文，不脱离原文新增闲聊或虚构任务承诺。\n- 保真要求：完整保留原文的否定、条件与例外、归因与确定性程度；准确对应已完成与待办、成功与失败状态；数字、单位、日期与操作指引完全吻合。\n- 格式保持：保留 Markdown 层级、表格与链接；代码、命令、路径与 API 标识符保持原样。',
  },
  {
    id: 'tsundere', label: '傲娇', contextWindow: 32768,
    instruction: '把输入的 Assistant 正文改写为嘴硬心软、带少许轻度吐槽但认真解释的傲娇语气，直接输出改写正文。微吐槽服务于内容，不喧宾夺主或脱离原文自聊。\n- 保真要求：必须准确交待原文结论与下一步；严格保留否定、条件、例外、归因、不确定性与已完成/待办状态；数字、单位、日期与技术术语准确对应。\n- 格式保持：保留 Markdown 结构；代码、命令、路径、URL 与标识符原样保留。',
  },
  {
    id: 'custom', label: '自定义', contextWindow: 32768,
    instruction: '保留原意，将输入的正文改写得简洁清晰，直接输出正文。严格保留否定、条件、例外、归因、不确定性程度以及已完成与待办状态；准确对应数字、单位、日期与专有名词；Markdown 结构与代码、命令、路径、标识符原样保留。',
  },
];

export function configuration(settings = {}) {
  const presets = settings.presets ? JSON.parse(settings.presets) : structuredClone(defaultPresets);
  if (!Array.isArray(presets) || presets.some((preset) => !preset.id || !preset.label || !preset.instruction)) throw new Error('预设必须包含 id、名称和提示词');
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length) throw new Error('预设 id 不能重复');
  return {
    enabled: true, presets, templates: structuredClone(defaultPresets),
    settings: {
      groupChars: settings.groupChars ?? 600,
      preloadBefore: settings.preloadBefore ?? 1,
      preloadAfter: settings.preloadAfter ?? 1,
      historyTokens: settings.historyTokens ?? 16384,
    },
  };
}
