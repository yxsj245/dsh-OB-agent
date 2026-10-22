/**
 * 模型自助管理工具：`agent_create` / `agent_update` / `agent_list`。
 *
 * 设计要点：
 * - 三个工具由本插件直接注册在 agent 自有层（不依赖任何 DSH 工具包），条目写入设置段；
 * - 默认作用域 `own`：模型只能创建/修改 `source === 'model'` 的条目，内置与用户条目安全；
 * - 每次写入都过 {@link validateEntry}，失败返回结构化中文原因，绝不写坏设置；
 * - 工具可见性在「下一轮请求」才生效，结果文案必须显式说明，否则模型会在同一轮里调用
 *   一个还不存在的工具；
 * - 每次创建/修改都写一条中文审计日志，便于用户回溯模型改了什么。
 */
import {
  ENTRY_LIMITS,
  subagentToolName,
  type EntryMode,
  type EntryPermission,
  type ObAgentEntry,
  type ObAgentModel,
  type ObAgentSection,
  type ObAgentSessionState,
  type SubagentProviderName,
} from './contract.ts'
import type { ToolDefinitionLike } from './context-types.ts'
import { normalizeEntry, validateEntry } from './normalize.ts'
import { effectiveSelection } from './plan.ts'

/** 写入条目表（可选同时写入会话记录）；合并写入，避免整段 replace 丢字段。 */
async function writeEntries(
  scope: { update(patch: object): Promise<void> },
  entries: readonly ObAgentEntry[],
  extra?: Record<string, unknown>,
): Promise<void> {
  await scope.update({ entries: entries.map(entry => ({ ...entry })), ...extra })
}

/**
 * 把一个新条目加入本会话勾选（`enableNow`）。
 *
 * 主机与浏览器写的是同一份 `sessions` 映射：这里按「本会话当前的有效勾选 + 新 id」整体写入，
 * 与设置页复选框的写法一致；总开关本身仍由用户控制，这里不会替用户打开它。
 *
 * 必须用 {@link effectiveSelection} 而不是「读到的记录」：本会话还没有记录时，有效勾选是
 * 「总开关默认 + 默认启用条目」，直接按空数组写入会把用户原本默认勾选的条目静默取消。
 * @param section - 当前设置段。
 * @param sessionId - 目标会话。
 * @param entryId - 新条目 id。
 * @returns 合并后的 `sessions` 补丁；会话未知时返回 undefined。
 */
function selectionPatch(
  section: ObAgentSection,
  sessionId: string | undefined,
  entryId: string,
): { sessions: Record<string, ObAgentSessionState>; enabled: boolean } | undefined {
  if (sessionId === undefined) return undefined
  const current = effectiveSelection(section, sessionId)
  const selected = [...new Set([...current.selected, entryId])]
  return {
    sessions: { ...section.sessions, [sessionId]: { enabled: current.enabled, selected } },
    enabled: current.enabled,
  }
}

/**
 * 读取「团队模式」开关。
 *
 * 团队模式下代理由 DSH 官方团队接管（本插件的闸门与条目选择同时让位），因此模型侧对条目的
 * 写入一律拒绝；只读的 `agent_list` 仍可用，并在结果里说明原因。
 * @param section - 当前设置段。
 * @returns 团队模式开启时为 true。
 */
function teamModeOf(section: ObAgentSection): boolean {
  return section.teamMode
}

/** 写入前的统一闸门：团队模式与自助管理开关；null 表示可以写。 */
function writeBlocker(section: ObAgentSection): string | null {
  if (teamModeOf(section)) {
    return '团队模式已开启：Agent 条目由主代理统一管理，模型的 agent_create / agent_update 被拒绝'
      + '（可用 agent_list 查看现有条目）'
  }
  if (!section.authoring.enabled) {
    return '模型自助管理已被用户关闭（设置 → 子代理 → 自助管理）'
  }
  return null
}

/** 本会话的有效勾选；会话未知时回落到出厂默认（`readSessions` 会丢弃空键，故空串等价于未知）。 */
function selectionOf(section: ObAgentSection, sessionId: string | undefined): ObAgentSessionState {
  return effectiveSelection(section, sessionId ?? '')
}

/** 单条路由的中文描述（含是否指定思考档位）。 */
function routeText(model: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): string {
  const effort = model.reasoningEffort
  return `${model.provider} / ${model.model}${effort === undefined ? '（未指定档位）' : `（档位 ${effort}）`}`
}

/**
 * 条目路由的中文描述：条目钉死的路由 / 跟随全局子代理模型 / 继承主会话。
 *
 * 与系统提示段（`describeActiveEntry`）和设置页保持同一优先级：条目 > 全局 > 会话。
 * @param entry - 子代理条目。
 * @param section - 当前设置段（读取 `subagentModel`）。
 */
function routeLabel(entry: ObAgentEntry, section: ObAgentSection): string {
  if (entry.model !== undefined) return routeText(entry.model)
  if (section.subagentModel !== undefined) return `跟随全局子代理模型：${routeText(section.subagentModel)}`
  return '继承主会话'
}

/** 全局子代理模型的中文描述（`agent_list` 末尾单列一行用）。 */
function globalRouteLabel(section: ObAgentSection): string {
  const model = section.subagentModel
  if (model === undefined) return '继承主会话（未单独钉死模型的条目沿用本会话模型）'
  const effort = model.reasoningEffort
  return `${model.provider} / ${model.model}${effort === undefined ? '' : `（档位 ${effort}）`}`
    + '（未单独钉死模型的条目使用；条目级模型优先）'
}

/** 条目权限档的中文描述（与系统提示段 `describeActiveEntry` 保持同一措辞）。 */
function permissionLabel(permission: EntryPermission): string {
  return permission === 'readonly' ? '只读' : '完全权限'
}

/** 条目上下文来源的中文描述（同上）。 */
function contextLabel(provider: SubagentProviderName): string {
  return provider === 'fork' ? '继承本会话已完成轮次' : '全新上下文'
}

/** 条目来源的中文描述。 */
function originLabel(source: ObAgentEntry['source']): string {
  return source === 'model' ? '模型自建' : source === 'builtin' ? '内置' : '用户创建'
}

/**
 * 条目在本会话的**真实**可用性。
 *
 * 三者缺一不可：闸门未关闭、条目纳管、本会话总开关开启且该条目被勾选。总开关关闭时
 * 绝不能显示「已启用」——勾选会保留，但工具确实不可用。
 * @param section - 当前设置段。
 * @param selection - 本会话的有效勾选。
 * @param entry - 待判定的条目。
 */
function availabilityLabel(
  section: ObAgentSection,
  selection: ObAgentSessionState,
  entry: ObAgentEntry,
): string {
  if (!section.gate.enabled) return '未纳管（闸门已关闭，按 DSH 原生行为可用）'
  if (!entry.managed) return '未纳管（工具不受本插件闸门约束）'
  if (!selection.enabled) return '不可用（本会话「子代理」总开关关闭）'
  return selection.selected.includes(entry.id) ? '本会话已启用' : '本会话未启用'
}

/** 条目的模型 / 模式 / 权限 / 上下文摘要（写入回执与 `agent_list` 共用）。 */
function entrySummary(entry: ObAgentEntry, section: ObAgentSection): string {
  if (entry.kind === 'native') return '模型与权限由 DSH 原生工具决定（不适用）'
  return `模型：${routeLabel(entry, section)}｜模式：可继续对话｜权限：${permissionLabel(entry.permission)}`
    + `｜上下文：${contextLabel(entry.provider)}`
}

/** 自助管理工具运行所需的上下文。 */
export interface AuthoringDeps {
  /** 读取当前设置段。 */
  read(): ObAgentSection
  /** 设置句柄（写入条目表）。 */
  scope: { update(patch: object): Promise<void> }
  /** 写一条中文审计日志。 */
  audit(message: string): void
  /** 由工具调用的 agent 解析会话 id。 */
  sessionIdOf(agent: { readonly session: { readonly id: string } } | undefined): string | undefined
  /** 面向模型的文档提示（路径或说明）。 */
  docHint(): string
}

/** 工具执行面的最小形状（本插件只读 agent 与会话）。 */
interface AuthoringExec {
  readonly agent?: { readonly session: { readonly id: string } }
}

/** 标识字段（创建与更新共用，两者都必填）。 */
const ID_PARAM = {
  type: 'string',
  required: true,
  description: 'Agent 标识：2-24 位、小写字母开头，仅含小写字母/数字/下划线；它决定工具名 subagent_<id>。更新用它定位条目。',
}
/** 名称字段（创建必填，更新可选）。 */
const NAME_PARAM = { type: 'string', description: `显示名称（不超过 ${ENTRY_LIMITS.name} 字符）。` }
/** 「何时调用」字段（创建必填，更新可选）。 */
const WHEN_PARAM = {
  type: 'string',
  description: '给主模型看的「何时调用」提示词：必须写清何时该调用、何时不要调用。',
}
/** 身份提示词字段（创建必填，更新可选）。 */
const IDENTITY_PARAM = {
  type: 'string',
  description: '给子代理看的身份提示词：它看不到父会话，必须自包含。',
}

/**
 * 创建与更新共用的字段表。
 *
 * 更新用它列出的**全部**字段（除 id 外都可省略，省略即保持原值）；创建把 name / whenPrompt /
 * identityPrompt 标成必填。因此「更新只需给要改的字段」是 Schema 与实现共同保证的契约，
 * 不是文档口号。
 */
const COMMON_PARAMETERS: Record<string, unknown> = {
  name: NAME_PARAM,
  whenPrompt: WHEN_PARAM,
  identityPrompt: IDENTITY_PARAM,
  description: { type: 'string', description: '一句话描述，用于界面展示；传空串表示清空。' },
  modes: {
    type: 'array',
    items: { type: 'string', enum: ['continuable'] },
    description: '只支持 continuable（可继续对话）；省略时使用该值。旧一次性模式已移除。',
  },
  provider: {
    type: 'string',
    enum: ['spawn', 'fork'],
    description: '子代理后端：spawn（全新上下文，默认）或 fork（继承已完成轮次）。',
  },
  permission: {
    type: 'string',
    enum: ['full', 'readonly'],
    description: '权限档：full（完全，默认）或 readonly（只能读文件，不能运行命令）。',
  },
  readOnlyAllow: {
    type: 'array',
    items: { type: 'string' },
    description: '只读权限下的工具白名单（省略则用全局白名单）。',
  },
  modelProvider: { type: 'string', description: '钉死的子模型 provider：必须与 model 成对给出；省略即保持原路由（新建时表示继承主会话）。' },
  model: { type: 'string', description: '钉死的子模型 id：必须与 modelProvider 成对给出；省略即保持原路由。' },
  reasoningEffort: {
    type: 'string',
    description: '思考档位（适配器自有的档位 id，例如 high）：只对已钉死的路由有意义；传空串清除档位。'
      + '切换路由时省略它不会继承旧路由的档位。',
  },
  inheritModel: {
    type: 'boolean',
    description: 'true = 显式恢复「继承主会话模型」（清除已有钉死路由）；与 modelProvider/model 互斥。'
      + '省略或 false 都表示不改变现有路由——清空路由不能用「漏传字段」表达。',
  },
  defaultEnabled: { type: 'boolean', description: '是否在新会话里默认勾选（默认 false）。' },
  enableNow: {
    type: 'boolean',
    description: '是否把该条目加入本会话勾选（默认 true；总开关没打开时只创建条目）。'
      + '传 false 表示本轮不动勾选，不会取消已有的勾选。',
  },
}

/**
 * 创建参数表：id / name / whenPrompt / identityPrompt 必填，其余可选。
 *
 * 必填覆盖刻意放在展开**之后**：同名键的插入位置不变（必填数组的顺序因此稳定为
 * id、name、whenPrompt、identityPrompt），但 `required` 标记以这里的为准。
 */
const CREATE_PARAMETERS: Record<string, unknown> = {
  id: ID_PARAM,
  ...COMMON_PARAMETERS,
  name: { ...NAME_PARAM, required: true },
  whenPrompt: { ...WHEN_PARAM, required: true },
  identityPrompt: { ...IDENTITY_PARAM, required: true },
}

/** 更新参数表：只有 id 必填，其余字段给出即改、省略即保持原值。 */
const UPDATE_PARAMETERS: Record<string, unknown> = {
  id: ID_PARAM,
  ...COMMON_PARAMETERS,
}

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args: Record<string, unknown>, value: unknown): readonly { type: 'text'; text: string }[] =>
    [{ type: 'text', text: String(value) }],
} as const

/**
 * 把「字段名 → 字段定义」的属性表编译成**模型可见的 JSON Schema**。
 *
 * 为什么必须编译：上游 `ToolSchema.parameters` 的契约是「JSON Schema object for the
 * arguments」，而 `{ 字段名: { type, required, description } }` 只是 `defineTool` 的
 * **作者侧 DSL** —— 只有经上游 `parameterSchemaSpecToJsonSchema` 编译后才会变成模型看到的
 * 形状。本插件刻意不依赖 `@deepseek-ai/dsh-tools`（它只发布在 DSH 自己的解析链上），
 * 直接 `tools.register()` 裸定义，因此这一步得自己做。漏做不会报错，只会静默降级：
 * Anthropic 系 provider 因为 `input_schema` 不是 object 而报错，OpenAI 系 provider 则把
 * 每个字段名当成未知关键字，参数说明形同虚设（模型只能靠 description 猜参数名）。
 *
 * 只编译**一层**：本插件的参数表全是顶层标量/数组字段，`items` 之类的嵌套定义原样透传。
 * 若将来加入嵌套对象字段，需要按上游语义递归编译（把内层 `required: true` 上提到内层
 * `required` 数组），否则内层的 `required` 会变成 JSON Schema 里的未知关键字。
 * @param properties - 字段名到字段定义的映射；`required: true` 表示该字段必填。
 * @returns 根为 object 的 JSON Schema（与上游编译结果同形）。
 */
export function parameterSchemaOf(properties: Record<string, unknown>): Record<string, unknown> {
  const required: string[] = []
  const compiled: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(properties)) {
    if (spec === null || typeof spec !== 'object') {
      // 形状不合预期时原样透传：交给注册方的校验去报错，本函数不制造新的失败点。
      compiled[name] = spec
      continue
    }
    const { required: isRequired, ...rest } = spec as { required?: unknown } & Record<string, unknown>
    compiled[name] = rest
    if (isRequired === true) required.push(name)
  }
  return {
    type: 'object',
    properties: compiled,
    ...(required.length === 0 ? {} : { required }),
  }
}

/** 参数解析结果：成功给出条目，失败给出全部中文原因（绝不静默降级到默认值）。 */
export type EntryDraft =
  | { readonly ok: true; readonly entry: ObAgentEntry; readonly enableNow: boolean }
  | { readonly ok: false; readonly errors: readonly string[] }

/** 读可选布尔参数：省略返回 undefined；给了非布尔值记一条中文错误。 */
function booleanArg(args: Record<string, unknown>, name: string, errors: string[]): boolean | undefined {
  if (args[name] === undefined) return undefined
  const value = args[name]
  if (typeof value !== 'boolean') {
    errors.push(`参数 ${name} 必须是布尔值 true 或 false（当前是 ${typeof value}）`)
    return undefined
  }
  return value
}

/**
 * 读可选文本参数。
 *
 * 刻意区分三种状态，避免「省略」被当成「清空」：
 * @returns 省略 → undefined；非字符串 → 记错并返回 undefined；空串或纯空白 → null（显式清空）。
 */
function textArg(args: Record<string, unknown>, name: string, errors: string[]): string | null | undefined {
  if (args[name] === undefined) return undefined
  const value = args[name]
  if (typeof value !== 'string') {
    errors.push(`参数 ${name} 必须是字符串（当前是 ${typeof value}）`)
    return undefined
  }
  return value.trim() === '' ? null : value
}

/**
 * 读模型路由参数（`modelProvider` + `model`）。
 *
 * 半填、空串、非字符串一律报错并保持返回 undefined：路由只能「成对切换」或「按原值保持」，
 * 不允许半个字段静默变成继承。切换回继承必须显式传 `inheritModel: true`。
 * @returns 成对且非空时为路由；未给出时为 undefined。
 */
function routeArg(
  args: Record<string, unknown>,
  errors: string[],
): { readonly provider: string; readonly model: string } | undefined {
  const providerRaw = args.modelProvider
  const modelRaw = args.model
  const hasProvider = providerRaw !== undefined
  const hasModel = modelRaw !== undefined
  if (!hasProvider && !hasModel) return undefined
  const local: string[] = []
  if (hasProvider && typeof providerRaw !== 'string') local.push('参数 modelProvider 必须是字符串')
  if (hasModel && typeof modelRaw !== 'string') local.push('参数 model 必须是字符串')
  if (hasProvider !== hasModel) {
    local.push('modelProvider 与 model 必须成对给出：只填一个既不会切换路由，也不会清除已有路由')
  }
  const provider = typeof providerRaw === 'string' ? providerRaw.trim() : ''
  const model = typeof modelRaw === 'string' ? modelRaw.trim() : ''
  if (hasProvider && hasModel && (provider === '' || model === '')) {
    local.push('modelProvider 与 model 都不能为空；要恢复继承主会话模型请显式传 inheritModel=true')
  }
  if (local.length > 0) {
    errors.push(...local)
    return undefined
  }
  return { provider, model }
}

/** 读只读工具白名单：必须是字符串数组（含非字符串或空项即报错，不做静默过滤）。 */
function readOnlyAllowArg(args: Record<string, unknown>, errors: string[]): readonly string[] | undefined {
  if (args.readOnlyAllow === undefined) return undefined
  const value = args.readOnlyAllow
  if (!Array.isArray(value)) {
    errors.push('参数 readOnlyAllow 必须是工具名数组')
    return undefined
  }
  const names: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push('参数 readOnlyAllow 只能包含非空工具名字符串')
      return undefined
    }
    names.push(item)
  }
  return names
}

/**
 * 计算本次写入后的模型路由。
 *
 * 规则与官方子选项合并保持一致：
 * - 省略 modelProvider/model：**保留** `base.model`（含 `reasoningEffort`），这是「部分更新」的核心；
 * - 成对给出且与旧路由不同：切换路由；未给 `reasoningEffort` 时**不继承旧路由的档位**（档位属于具体路由）；
 * - 成对给出且与旧路由相同：只改档位/保持不变；
 * - `inheritModel: true`：显式清空路由，回到继承主会话。
 * @param route - 本次给出的新路由（未给出为 undefined）。
 * @param base - 被修改的条目的旧路由；新建时为 undefined。
 * @param effort - `undefined` = 省略（保持）；`null` = 空串（显式清除）；字符串 = 显式设置。
 */
function resolveModel(
  route: { readonly provider: string; readonly model: string } | undefined,
  base: ObAgentModel | undefined,
  effort: string | null | undefined,
  inheritModel: boolean | undefined,
  errors: string[],
): ObAgentModel | undefined {
  if (inheritModel === true) {
    if (typeof effort === 'string') errors.push('inheritModel=true 时不能同时设置 reasoningEffort：继承路由没有固定档位')
    return undefined
  }
  const withEffort = (provider: string, model: string, value: string | undefined): ObAgentModel =>
    value === undefined ? { provider, model } : { provider, model, reasoningEffort: value }
  if (route !== undefined) {
    const sameRoute = base !== undefined && base.provider === route.provider && base.model === route.model
    const next = typeof effort === 'string'
      ? effort
      : effort === null ? undefined : (sameRoute ? base?.reasoningEffort : undefined)
    return withEffort(route.provider, route.model, next)
  }
  if (base === undefined) {
    if (typeof effort === 'string') {
      errors.push('未钉死模型路由时不能设置 reasoningEffort：请先用 modelProvider 与 model 指定路由')
    }
    return undefined
  }
  const next = effort === undefined ? base.reasoningEffort : effort === null ? undefined : effort
  return withEffort(base.provider, base.model, next)
}

/**
 * 由模型参数构造条目：新建得到 `source: 'model'` 的条目，更新时**保留 base 的来源与纳管状态**。
 *
 * 保留 `base.source` 是安全边界：若把内置/用户条目改写成「模型自建」，即使之后作用域收回
 * `own`，模型仍能继续改这条本不属于它的条目，等于绕过作用域限制。
 * @param args - 模型给出的工具参数。
 * @param base - 更新时的原条目；新建时为 undefined。
 * @returns 成功给出条目，失败给出全部中文原因（不做任何静默降级）。
 */
export function entryFromArgs(args: Record<string, unknown>, base?: ObAgentEntry): EntryDraft {
  const errors: string[] = []
  const idRaw = args.id
  let id = base?.id
  if (idRaw !== undefined) {
    if (typeof idRaw !== 'string' || idRaw.trim() === '') {
      errors.push('参数 id 必须是 2-24 位、小写字母开头的非空字符串')
    } else {
      id = idRaw.trim()
    }
  }
  if (id === undefined) errors.push('缺少 id')
  const modesRaw = args.modes
  if (modesRaw !== undefined) {
    if (!Array.isArray(modesRaw)) errors.push('参数 modes 必须是数组，且只接受 ["continuable"]')
    else if (modesRaw.length === 0) errors.push('运行模式只支持 continuable，不能给空数组')
    else if (modesRaw.some(mode => mode !== 'continuable')) {
      errors.push('运行模式只支持 continuable，DSH 已移除新建一次性子代理')
    }
  }
  const modes: EntryMode[] = ['continuable']
  const providerRaw = args.provider
  if (providerRaw !== undefined && providerRaw !== 'spawn' && providerRaw !== 'fork') {
    errors.push('参数 provider 只接受 spawn（全新上下文）或 fork（继承本会话已完成轮次）')
  }
  const provider: SubagentProviderName = providerRaw === 'fork' || providerRaw === 'spawn'
    ? providerRaw
    : (base?.provider ?? 'spawn')
  const permissionRaw = args.permission
  if (permissionRaw !== undefined && permissionRaw !== 'full' && permissionRaw !== 'readonly') {
    errors.push('参数 permission 只接受 full（完全权限）或 readonly（只读）')
  }
  const permission: EntryPermission = permissionRaw === 'readonly' || permissionRaw === 'full'
    ? permissionRaw
    : (base?.permission ?? 'full')
  const readOnlyAllow = readOnlyAllowArg(args, errors) ?? base?.readOnlyAllow
  const route = routeArg(args, errors)
  const inheritModel = booleanArg(args, 'inheritModel', errors)
  if (inheritModel === true && (args.modelProvider !== undefined || args.model !== undefined)) {
    errors.push('inheritModel 与 modelProvider/model 互斥：要么恢复继承，要么钉死新路由')
  }
  const effort = textArg(args, 'reasoningEffort', errors)
  const model = resolveModel(route, base?.model, effort, inheritModel, errors)
  const nameRaw = textArg(args, 'name', errors)
  const whenRaw = textArg(args, 'whenPrompt', errors)
  const identityRaw = textArg(args, 'identityPrompt', errors)
  const descriptionRaw = textArg(args, 'description', errors)
  const draft = normalizeEntry({
    id: id ?? '',
    kind: 'subagent',
    source: base?.source ?? 'model',
    managed: base?.managed ?? true,
    defaultEnabled: booleanArg(args, 'defaultEnabled', errors) ?? base?.defaultEnabled ?? false,
    name: nameRaw === undefined ? (base?.name ?? '') : (nameRaw ?? ''),
    description: descriptionRaw === undefined ? (base?.description ?? '') : (descriptionRaw ?? ''),
    whenPrompt: whenRaw === undefined ? (base?.whenPrompt ?? '') : (whenRaw ?? ''),
    identityPrompt: identityRaw === undefined ? (base?.identityPrompt ?? '') : (identityRaw ?? ''),
    modes,
    provider,
    permission,
    ...(readOnlyAllow !== undefined ? { readOnlyAllow } : {}),
    ...(model !== undefined ? { model } : {}),
  })
  // `enableNow` 属于工具行为而非条目字段：与其它参数一起校验（非布尔值即失败），由调用方
  // 决定是否写本会话勾选，避免同一参数被解析两次、也避免非法值静默当成 true。
  const enableNow = booleanArg(args, 'enableNow', errors)
  if (draft !== undefined && errors.length === 0) {
    return { ok: true, entry: draft, enableNow: enableNow ?? true }
  }
  if (draft === undefined) {
    errors.push(base === undefined
      ? '条目结构不合法：新建条目必须给出合法的 id、非空名称与身份提示词'
      : '条目结构不合法：更新后的 id、名称或身份提示词形状错误')
  }
  return { ok: false, errors }
}

/** 统一的失败文案：把原因与文档位置一起交给模型。 */
function failureText(errors: readonly string[], docHint: string): string {
  return ['操作被拒绝：', ...errors.map(error => `- ${error}`), '', `字段与写法规范见 ${docHint}`].join('\n')
}

/** 构造三个自助管理工具的定义。 */
export function authoringTools(deps: AuthoringDeps): ToolDefinitionLike[] {
  /** 创建/修改成功后的落地说明：是否已在本会话启用，以及下一次可用时机。 */
  const describeOutcome = (
    entry: ObAgentEntry,
    section: ObAgentSection,
    enableNow: boolean,
    sessionId: string | undefined,
    selectedNow: boolean,
  ): string => {
    const toolNames = entry.modes.map(mode => subagentToolName(entry.id, mode))
    const lines = [
      `已保存 Agent 条目 ${entry.id}（${entry.name}）。`,
      `它将提供的工具：${toolNames.map(name => `\`${name}\``).join('、')}。`,
      entrySummary(entry, section),
    ]
    const selection = selectionOf(section, sessionId)
    // 与入参 `enableNow` 区分：这里问的是「按当前设置，它此刻是否真的可用」。
    const availableNow = section.gate.enabled && selection.enabled
    if (!enableNow) {
      lines.push('未在本会话启用（enableNow=false）：请让用户在聊天框的「子代理」面板勾选它。')
    } else if (!section.gate.enabled) {
      lines.push('闸门已关闭（逃生舱）：本插件不干预 Agent 工具，可用性由 DSH 原生行为决定。')
    } else if (!availableNow) {
      lines.push('本会话的「子代理」总开关当前是关闭的：该条目已加入本会话勾选，但需要用户打开总开关后工具才可用。')
    } else if (selectedNow) {
      lines.push('已加入本会话勾选：新工具将在「下一轮请求」才出现在你的工具清单里，本轮不要调用它。')
    } else {
      lines.push('工具将在「下一轮请求」才按本会话勾选出现在你的工具清单里，本轮不要调用它。')
    }
    if (entry.permission === 'readonly') {
      lines.push(`只读权限生效时该子代理只能使用这些工具：${(entry.readOnlyAllow ?? section.readOnlyTools).join('、')}。`)
    }
    return lines.join('\n')
  }

  const create: ToolDefinitionLike = {
    name: 'agent_create',
    description:
      '新建一个可复用的 Agent 条目（子代理预设）并持久化。适用于会反复出现、值得固化成固定身份/权限/模型的委派任务；'
      + '一次性小任务不要建条目。创建成功后该子代理工具在「下一轮请求」才可用。'
      + '模型路由用 modelProvider+model（必须成对，可再加 reasoningEffort）；都省略则继承主会话。',
    parameters: parameterSchemaOf(CREATE_PARAMETERS),
    isConcurrencySafe: () => false,
    output: OUTPUT,
    async execute(args, exec): Promise<unknown> {
      const section = deps.read()
      const doc = deps.docHint()
      const blocker = writeBlocker(section)
      if (blocker !== null) return failureText([blocker], doc)
      if (section.entries.length >= section.authoring.maxEntries) {
        return failureText([`条目总数已达上限 ${section.authoring.maxEntries}；请先让用户删除不用的条目`], doc)
      }
      const draft = entryFromArgs(args)
      if (!draft.ok) return failureText(draft.errors, doc)
      const errors = validateEntry(draft.entry, section, { takenIds: section.entries.map(entry => entry.id) })
      if (errors.length > 0) return failureText(errors, doc)
      const sessionId = deps.sessionIdOf((exec as AuthoringExec).agent)
      const patch = draft.enableNow ? selectionPatch(section, sessionId, draft.entry.id) : undefined
      await writeEntries(
        deps.scope,
        [...section.entries, draft.entry],
        patch === undefined ? undefined : { sessions: patch.sessions },
      )
      deps.audit(`模型创建了 Agent 条目 ${draft.entry.id}（${draft.entry.name}）`)
      return describeOutcome(draft.entry, section, draft.enableNow, sessionId, patch !== undefined)
    },
  }

  const update: ToolDefinitionLike = {
    name: 'agent_update',
    description:
      '修改一个已有的 Agent 条目：只有 id 必填，其余字段省略即保持原值（包括钉死的模型路由与思考档位）。'
      + '要清除模型路由回到「继承主会话」时必须显式传 inheritModel=true，漏传字段不会清空路由；'
      + '切换路由时若不传 reasoningEffort，则不继承旧路由的档位。'
      + '默认只能修改模型自己创建的条目（来源为模型）；修改内置或用户创建的条目会被拒绝。',
    parameters: parameterSchemaOf(UPDATE_PARAMETERS),
    isConcurrencySafe: () => false,
    output: OUTPUT,
    async execute(args, exec): Promise<unknown> {
      const section = deps.read()
      const doc = deps.docHint()
      const blocker = writeBlocker(section)
      if (blocker !== null) return failureText([blocker], doc)
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const base = section.entries.find(entry => entry.id === id)
      if (base === undefined) {
        return failureText([`没有这个条目：${id}（先用 agent_list 查看现有条目标识）`], doc)
      }
      if (base.kind === 'native') {
        return failureText([`${id} 是 DSH 原生工具条目，不能按子代理字段修改`], doc)
      }
      if (section.authoring.scope === 'own' && base.source !== 'model') {
        return failureText([`${id} 不是模型创建的条目（来源：${originLabel(base.source)}），当前作用域只允许修改模型自建条目`], doc)
      }
      const draft = entryFromArgs(args, base)
      if (!draft.ok) return failureText(draft.errors, doc)
      const errors = validateEntry(draft.entry, section, {
        takenIds: section.entries.filter(entry => entry.id !== id).map(entry => entry.id),
      })
      if (errors.length > 0) return failureText(errors, doc)
      // `enableNow=true`（默认）顺带把该条目补进本会话勾选；已勾选时不写，避免无意义的设置写入。
      // `enableNow=false` 只表示「本轮不动勾选」，不会把它从勾选里移除（那是设置页的操作）。
      const sessionId = deps.sessionIdOf((exec as AuthoringExec).agent)
      const selected = selectionOf(section, sessionId).selected.includes(id)
      const patch = draft.enableNow && !selected ? selectionPatch(section, sessionId, id) : undefined
      await writeEntries(
        deps.scope,
        section.entries.map(entry => (entry.id === id ? draft.entry : entry)),
        patch === undefined ? undefined : { sessions: patch.sessions },
      )
      deps.audit(`模型修改了 Agent 条目 ${id}（${draft.entry.name}，来源保持${originLabel(draft.entry.source)}）`)
      return describeOutcome(draft.entry, section, draft.enableNow, sessionId, patch !== undefined)
    },
  }

  const list: ToolDefinitionLike = {
    name: 'agent_list',
    description:
      '列出当前全部 Agent 条目（含未勾选与模型自建项）：标识、名称、类型、来源、本会话是否真的可用、会暴露的工具名，'
      + '以及模型路由与思考档位（含用户的全局子代理模型设置，条目级模型优先）、权限档、上下文来源（spawn/fork）。新建或修改条目之前先用它查重并确认现状。'
      + '「本会话已启用」是闸门 + 总开关 + 勾选三者共同成立的结果，总开关关闭时不会有任何条目显示为已启用。',
    parameters: parameterSchemaOf({}),
    isConcurrencySafe: () => true,
    output: OUTPUT,
    execute(_args, exec): Promise<unknown> {
      const section = deps.read()
      const selection = selectionOf(section, deps.sessionIdOf((exec as AuthoringExec).agent))
      const lines = ['当前 Agent 条目：']
      for (const entry of section.entries) {
        const names = entry.kind === 'native'
          ? (entry.toolNames ?? []).join('、')
          : entry.modes.map(mode => subagentToolName(entry.id, mode)).join('、')
        lines.push(
          `- ${entry.id}｜${entry.name}｜${entry.kind === 'native' ? '原生工具' : '子代理'}`
          + `｜${originLabel(entry.source)}${entry.managed ? '' : '（未纳管）'}`
          + `｜${availabilityLabel(section, selection, entry)}｜工具：${names || '（无）'}`
          + `｜${entrySummary(entry, section)}｜默认勾选：${entry.defaultEnabled ? '是' : '否'}`,
        )
      }
      lines.push(`全局子代理模型：${globalRouteLabel(section)}。`)
      lines.push(`总开关默认：${section.masterEnabledDefault ? '开' : '关'}；条目上限：${section.authoring.maxEntries} 条。`)
      if (!section.gate.enabled) {
        lines.push('闸门当前已关闭（逃生舱）：本插件不干预 Agent 工具，条目的启用状态不影响可用性。')
      } else if (!selection.enabled) {
        lines.push('本会话的「子代理」总开关当前是关闭的：上面所有条目在本会话都不可用。')
      }
      if (teamModeOf(section)) {
        lines.push('注意：团队模式已开启，条目由主代理统一管理，你不能创建或修改条目（agent_create / agent_update 会被拒绝）。')
      }
      if (!section.authoring.enabled) lines.push('注意：模型自助管理当前已被用户关闭，你不能创建或修改条目。')
      return Promise.resolve(lines.join('\n'))
    },
  }

  return [create, update, list]
}
