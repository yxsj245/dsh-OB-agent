/**
 * 纯归一化与校验：把任意设置段补齐成完整形状，并在写入前做严格校验。
 *
 * 这个模块**不得引入任何运行期依赖**（不 import schemastery、不 import DSH 包）：
 * 浏览器半要用同一份逻辑做本地校验与默认值补齐，而客户端 bundle 里无法 require 这些包。
 * schemastery 模式只出现在 host 专用的 `settings.ts` 里。
 */
import {
  ENTRY_ID_PATTERN,
  ENTRY_LIMITS,
  MAX_SESSION_STATES,
  VARIABLE_PATTERN,
  type EntryMode,
  type NativeImpl,
  type ObAgentAuthoring,
  type ObAgentEntry,
  type ObAgentGate,
  type ObAgentModel,
  type ObAgentModelGuide,
  type ObAgentSection,
  type ObAgentSessionState,
} from './contract.ts'
import { BUILTIN_ENTRIES, DEFAULTS_REVISION, DEFAULT_SECTION, RENAMED_BUILTINS } from './defaults.ts'

/** 读成字符串数组；非数组返回 undefined（含非字符串项时过滤掉）。 */
export function readStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

/** 读成布尔；非布尔返回 undefined。 */
export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** 归一化闸门段。 */
export function readGate(value: unknown): ObAgentGate {
  const raw = (value ?? {}) as Record<string, unknown>
  return {
    enabled: readBoolean(raw.enabled) ?? DEFAULT_SECTION.gate.enabled,
    prefixes: readStrings(raw.prefixes) ?? [...DEFAULT_SECTION.gate.prefixes],
    tools: readStrings(raw.tools) ?? [...DEFAULT_SECTION.gate.tools],
    allow: readStrings(raw.allow) ?? [...DEFAULT_SECTION.gate.allow],
    reprovide: readStrings(raw.reprovide) ?? [...DEFAULT_SECTION.gate.reprovide],
  }
}

/** 归一化自助管理段。 */
export function readAuthoring(value: unknown): ObAgentAuthoring {
  const raw = (value ?? {}) as Record<string, unknown>
  const maxEntries = typeof raw.maxEntries === 'number' && Number.isFinite(raw.maxEntries)
    ? Math.max(0, Math.trunc(raw.maxEntries))
    : DEFAULT_SECTION.authoring.maxEntries
  return {
    enabled: readBoolean(raw.enabled) ?? DEFAULT_SECTION.authoring.enabled,
    scope: raw.scope === 'all' ? 'all' : 'own',
    maxEntries,
  }
}

/** 归一化文档注入段。 */
export function readModelGuide(value: unknown): ObAgentModelGuide {
  const raw = (value ?? {}) as Record<string, unknown>
  return { inject: raw.inject === 'inline' || raw.inject === 'off' ? raw.inject : DEFAULT_SECTION.modelGuide.inject }
}

/**
 * 归一化模型路由（provider + model + 可选思考档位）。
 *
 * 只接受对象且 provider/model 都是字符串；`null`、缺字段、非对象一律返回 undefined，
 * 表示「继承」（条目继承该条目的默认行为，全局设置继承主会话）。空串由校验层拒绝，
 * 不在这里静默当继承——那会让用户以为已经钉死了路由。
 * @param value - 待归一化的原始值。
 * @returns 完整路由，或 undefined 表示未指定。
 */
export function readModel(value: unknown): ObAgentModel | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') return undefined
  return {
    provider: raw.provider,
    model: raw.model,
    ...(typeof raw.reasoningEffort === 'string' && raw.reasoningEffort !== ''
      ? { reasoningEffort: raw.reasoningEffort }
      : {}),
  }
}

const IMPLS: readonly NativeImpl[] = ['workflow', 'ralph', 'control', 'list-agents', 'subagent-preset', 'authoring']

/** 归一化单条条目；结构不成立时返回 undefined（调用方告警并跳过）。 */
export function normalizeEntry(value: unknown): ObAgentEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!ENTRY_ID_PATTERN.test(id)) return undefined
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (name.trim() === '') return undefined
  const kind = raw.kind === 'native' ? 'native' : 'subagent'
  const source = raw.source === 'builtin' || raw.source === 'user' ? raw.source : 'model'
  // 旧 one-shot / 双模式条目只迁移模式，不覆盖用户身份、模型、权限或会话勾选。
  const modes: EntryMode[] = kind === 'subagent' ? ['continuable'] : []
  const model = readModel(raw.model)
  const impl = typeof raw.impl === 'string' && (IMPLS as readonly string[]).includes(raw.impl)
    ? raw.impl as NativeImpl
    : undefined
  const toolNames = readStrings(raw.toolNames)
  const readOnlyAllow = readStrings(raw.readOnlyAllow)
  return {
    id,
    kind,
    source,
    managed: readBoolean(raw.managed) ?? true,
    defaultEnabled: readBoolean(raw.defaultEnabled) ?? false,
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    whenPrompt: typeof raw.whenPrompt === 'string' ? raw.whenPrompt : '',
    ...(typeof raw.identityPrompt === 'string' ? { identityPrompt: raw.identityPrompt } : {}),
    modes,
    provider: raw.provider === 'fork' ? 'fork' : 'spawn',
    ...(model !== undefined ? { model } : {}),
    permission: raw.permission === 'readonly' ? 'readonly' : 'full',
    ...(readOnlyAllow !== undefined ? { readOnlyAllow } : {}),
    ...(impl !== undefined ? { impl } : {}),
    ...(toolNames !== undefined ? { toolNames } : {}),
  }
}

/** 归一化会话选择映射（丢弃形状不合法的键，并按上限截断）。 */
export function readSessions(value: unknown): Record<string, ObAgentSessionState> {
  if (value === null || typeof value !== 'object') return {}
  const result: Record<string, ObAgentSessionState> = {}
  let count = 0
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_SESSION_STATES) break
    if (key === '' || item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const enabled = readBoolean(raw.enabled)
    const selected = readStrings(raw.selected)
    if (enabled === undefined || selected === undefined) continue
    result[key] = { enabled, selected }
    count += 1
  }
  return result
}

/** 读出厂默认版本号；非法值一律当作 0（即「从未迁移过」）。 */
export function readRevision(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** 从任意原始设置段里取出版本号（迁移判定用，不依赖补齐后的形状）。 */
export function storedRevision(raw: unknown): number {
  const value = (raw ?? {}) as Record<string, unknown>
  return readRevision(value.defaultsRevision)
}

/** 迁移结果：新设置段 + 是否发生变化（调用方据此决定是否回写）。 */
export interface MigrationResult {
  readonly section: ObAgentSection
  readonly changed: boolean
}

/**
 * 把历史设置段迁移到当前出厂默认版本。
 *
 * 规则（只动内置条目，绝不碰用户/模型自建的条目）：
 * 1. 改名的内置标识按 `RENAMED_BUILTINS` 重定向到新标识；
 * 2. v0/1 的同名内置条目取当前出厂值，保留「是否纳入管理」开关；v2 及以后版本只更新
 *    代码审查的描述和两段提示词，其余（包括用户调整过的模型、默认勾选）保持不变；
 * 3. 已下线的内置条目从表里移除——它们对应的工具名仍留在闸门拦截名单里，因此不会被意外放行；
 * 4. 设置段里没有的内置条目**不补**：新增的内置角色只随全新安装出现，绝不把用户删掉的条目
 *    再塞回去（条目表为空说明设置已损坏，此时按空表工作比悄悄复原更可预期）；
 * 5. 会话选择按重定向改写，并清掉指向已下线条目的 id（否则改名会让旧会话的勾选凭空消失）。
 * @param section - 已补齐形状的设置段。
 * @returns 迁移后的设置段与是否发生变化。
 */
export function migrateSection(section: ObAgentSection): MigrationResult {
  if (section.defaultsRevision >= DEFAULTS_REVISION) return { section, changed: false }
  const fresh = new Map(BUILTIN_ENTRIES.map(entry => [entry.id, entry]))
  // v2 及以后版本已经使用过成本优先版字段；后续版本只更新审查提示词，保留用户的模型与勾选设置。
  const reviewPromptOnly = section.defaultsRevision >= 2
  const replacementOf = (entry: ObAgentEntry, replacement: ObAgentEntry): ObAgentEntry =>
    reviewPromptOnly && entry.id === 'code_review'
      ? {
          ...entry,
          description: replacement.description,
          whenPrompt: replacement.whenPrompt,
          identityPrompt: replacement.identityPrompt,
        }
      : reviewPromptOnly ? entry : { ...replacement, managed: entry.managed }
  const entries: ObAgentEntry[] = []
  const kept = new Set<string>()
  // 改名映射与「设置段里是否真的存在旧标识」无关：历史设置段可能整块没有 entries 键
  // （此时已经回填成新出厂表），但会话选择里仍然残留着旧标识。
  const renamed = new Map<string, string>(Object.entries(RENAMED_BUILTINS))
  // 表里出现过的全部标识（含排在旧标识之后的）：重定向目标若本来就在表里，绝不能再补一份，
  // 否则「旧标识在前、新标识在后」的顺序会产出同 id 的重复条目。
  const seen = new Set(section.entries.map(entry => entry.id))
  for (const entry of section.entries) {
    if (entry.source !== 'builtin') {
      entries.push(entry)
      kept.add(entry.id)
      continue
    }
    const target = RENAMED_BUILTINS[entry.id]
    if (target !== undefined) {
      // 旧标识条目：新标识若确实不在表里（例如表里只剩这一条），用出厂值补进去。
      const replacement = fresh.get(target)
      if (replacement !== undefined && !kept.has(target) && !seen.has(target)) {
        entries.push({ ...replacement, managed: entry.managed })
        kept.add(target)
      }
      continue
    }
    const replacement = fresh.get(entry.id)
    // 出厂表里没有这个标识：可能是已下线的内置条目（如旧版 fork），也可能是出厂表从未
    // 包含过的历史标识。两种都直接丢弃——它们对应的工具名仍留在闸门拦截名单里，不会被放行。
    if (replacement === undefined) continue
    entries.push(replacementOf(entry, replacement))
    kept.add(entry.id)
  }
  const sessions: Record<string, ObAgentSessionState> = {}
  for (const [id, state] of Object.entries(section.sessions)) {
    const selected = [...new Set(state.selected.map(item => renamed.get(item) ?? item))]
      .filter(item => kept.has(item))
    sessions[id] = { enabled: state.enabled, selected }
  }
  return {
    section: { ...section, defaultsRevision: DEFAULTS_REVISION, entries, sessions },
    changed: true,
  }
}

/** 把一个可能不完整的设置段补齐成完整形状（缺省即出厂默认）。 */
export function readSection(raw: unknown): ObAgentSection {
  const value = (raw ?? {}) as Record<string, unknown>
  const entries = Array.isArray(value.entries)
    ? (value.entries as unknown[]).map(normalizeEntry).filter((entry): entry is ObAgentEntry => entry !== undefined)
    : [...DEFAULT_SECTION.entries]
  const subagentModel = readModel(value.subagentModel)
  const section: ObAgentSection = {
    defaultsRevision: readRevision(value.defaultsRevision),
    masterEnabledDefault: readBoolean(value.masterEnabledDefault) ?? DEFAULT_SECTION.masterEnabledDefault,
    teamMode: readBoolean(value.teamMode) ?? DEFAULT_SECTION.teamMode,
    ...(typeof value.dshHome === 'string' && value.dshHome.trim() !== '' ? { dshHome: value.dshHome } : {}),
    readOnlyTools: readStrings(value.readOnlyTools) ?? [...DEFAULT_SECTION.readOnlyTools],
    promptVariables: readStrings(value.promptVariables) ?? [...DEFAULT_SECTION.promptVariables],
    autoEnableControlWithContinuable:
      readBoolean(value.autoEnableControlWithContinuable) ?? DEFAULT_SECTION.autoEnableControlWithContinuable,
    childReplyToParent: readBoolean(value.childReplyToParent) ?? DEFAULT_SECTION.childReplyToParent,
    gate: readGate(value.gate),
    authoring: readAuthoring(value.authoring),
    modelGuide: readModelGuide(value.modelGuide),
    ...(subagentModel !== undefined ? { subagentModel } : {}),
    entries,
    sessions: readSessions(value.sessions),
  }
  return migrateSection(section).section
}

/** 收集文本里出现的**合法**提示词变量名（严格与运行时插值器一致）。 */
export function collectVariables(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    if (match[1] !== undefined) found.add(match[1])
  }
  return [...found]
}

/**
 * 找出文本里所有**畸形**的 `{{` 引用（运行时会抛错并打断整个请求）。
 *
 * 判定方式与 `dsh-system-prompt` 的 `interpolate` 相同：在每处 `{{` 上做锚定匹配，
 * 只有严格等于 `{{小写名字}}` 的才合法；`{{{cwd}}}`、`{{ cwd }}`、`{{Cwd}}`、`{{a-b}}`
 * 以及落单的 `{{` 都会被列出。
 * @param text - 待检查的提示词文本。
 * @returns 畸形引用的片段（最多 16 字符，仅用于报错提示）。
 */
export function findMalformedReferences(text: string): string[] {
  const malformed: string[] = []
  const strict = /^\{\{([a-z][a-z0-9_]*)\}\}/
  let index = 0
  for (;;) {
    const open = text.indexOf('{{', index)
    if (open === -1) break
    const match = strict.exec(text.slice(open))
    if (match === null) {
      malformed.push(text.slice(open, open + 16))
      index = open + 2
      continue
    }
    index = open + match[0].length
  }
  return malformed
}

/** 校验一条条目；返回中文原因列表（空数组 = 通过）。 */
export function validateEntry(
  entry: ObAgentEntry,
  section: Pick<ObAgentSection, 'promptVariables' | 'readOnlyTools'>,
  options: { takenIds: readonly string[] },
): string[] {
  const errors: string[] = []
  if (!ENTRY_ID_PATTERN.test(entry.id)) {
    errors.push(`标识必须是 2-24 位、小写字母开头，且只含小写字母/数字/下划线：${entry.id}`)
  } else if (options.takenIds.includes(entry.id)) {
    errors.push(`标识已被占用：${entry.id}`)
  }
  if (entry.name.trim() === '') errors.push('名称不能为空')
  if (entry.name.length > ENTRY_LIMITS.name) errors.push(`名称过长（上限 ${ENTRY_LIMITS.name} 字符）`)
  if (entry.description.length > ENTRY_LIMITS.description) {
    errors.push(`描述过长（上限 ${ENTRY_LIMITS.description} 字符）`)
  }
  if (entry.whenPrompt.trim() === '') errors.push('「何时调用」提示词不能为空')
  if (entry.whenPrompt.length > ENTRY_LIMITS.prompt) {
    errors.push(`「何时调用」提示词过长（上限 ${ENTRY_LIMITS.prompt} 字符）`)
  }
  if (entry.kind === 'subagent') {
    if (entry.modes.length === 0) errors.push('子代理条目至少要选择一种运行模式')
    if ((entry.identityPrompt ?? '').trim() === '') errors.push('子代理条目必须提供身份提示词')
    if ((entry.identityPrompt ?? '').length > ENTRY_LIMITS.prompt) {
      errors.push(`身份提示词过长（上限 ${ENTRY_LIMITS.prompt} 字符）`)
    }
    if (entry.permission === 'readonly' && (entry.readOnlyAllow ?? section.readOnlyTools).length === 0) {
      errors.push('只读权限需要非空的只读工具白名单')
    }
    if (entry.model !== undefined && (entry.model.provider.trim() === '' || entry.model.model.trim() === '')) {
      errors.push('模型路由需要同时给出 provider 与 model')
    }
  } else {
    if (entry.impl === undefined) errors.push('原生条目必须指定实现')
    if ((entry.toolNames ?? []).length === 0) errors.push('原生条目必须给出工具名')
  }
  for (const text of [entry.whenPrompt, entry.identityPrompt ?? '', entry.name, entry.description]) {
    for (const snippet of findMalformedReferences(text)) {
      errors.push(
        `提示词里有无法解析的变量引用「${snippet}」：只能写 {{小写名字}} 形式`
        + '（不允许空格、大写与其它字符；写错会让整个模型请求失败）',
      )
    }
    for (const name of collectVariables(text)) {
      if (!section.promptVariables.includes(name)) {
        errors.push(`提示词变量 {{${name}}} 不在允许列表内（当前允许：${section.promptVariables.join('、') || '无'}）`)
      }
    }
  }
  return errors
}

/** 校验一个完整设置段（设置页保存与模型写入前共用）。 */
export function validateSection(section: ObAgentSection): string[] {
  const errors: string[] = []
  if (section.entries.length === 0) errors.push('至少要保留一条 Agent 条目')
  // 全局模型与条目级模型同一套规则：路由必须成对且非空，半填状态不允许落盘。
  if (
    section.subagentModel !== undefined
    && (section.subagentModel.provider.trim() === '' || section.subagentModel.model.trim() === '')
  ) {
    errors.push('全局子代理模型需要同时给出 provider 与 model')
  }
  if (section.readOnlyTools.length === 0 && section.entries.some(entry => entry.kind === 'subagent' && entry.permission === 'readonly')) {
    errors.push('存在只读条目时，只读工具白名单不能为空')
  }
  if (section.authoring.maxEntries < section.entries.length) {
    errors.push(`条目上限（${section.authoring.maxEntries}）小于当前条目数（${section.entries.length}）`)
  }
  const seen = new Set<string>()
  for (const entry of section.entries) {
    errors.push(...validateEntry(entry, section, { takenIds: [...seen] }).map(message => `[${entry.id}] ${message}`))
    seen.add(entry.id)
  }
  return errors
}
