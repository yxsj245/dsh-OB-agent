/**
 * 共享契约：主机（host）与浏览器（client）两半共用的类型、常量与纯函数。
 *
 * 会话级选择存放在设置命名空间的 `sessions` 映射里（键为会话 id），因此浏览器只需
 * 会话选择与全局设置保存在插件 live Config 的 `section` 字段中，由 `configForms` 同步，
 * 不需要自定义 Remote、投影或 HTTP 路由。
 * 主机侧在每次模型请求前读取同一份映射来决定闸门拒绝集与可见工具集。
 */

/** 旧版 DSH 设置文档使用的命名空间名，供数据迁移参考。 */
export const OB_AGENT_NAMESPACE = 'ob-agent'

/** 系统提示段名（每个 agent 作用域各注册一份，同名遮蔽）。 */
export const SECTION_NAME = 'ob-agent:agents'

/** 条目种类：子代理（本插件装配）或 DSH 原生工具（放行 / 本层重挂）。 */
export type EntryKind = 'subagent' | 'native'

/** 条目来源：内置、用户手建、模型自建（模型只能改自己建的）。 */
export type EntrySource = 'builtin' | 'user' | 'model'

/** 新建子代理只支持可继续对话；一次性仅在历史 descriptor 读取层保留。 */
export type EntryMode = 'continuable'

/** 权限档：只读（文件读取类工具白名单）/ 完全。 */
export type EntryPermission = 'readonly' | 'full'

/** 子代理后端提供方名（DSH 内置的两个 in-process 提供方）。 */
export type SubagentProviderName = 'spawn' | 'fork'

/** DSH 原生工具条目的实现包标识。 */
export type NativeImpl =
  | 'workflow'
  | 'ralph'
  | 'control'
  | 'list-agents'
  | 'subagent-preset'
  | 'authoring'

/** 预设钉死的子模型路由；缺省表示继承主会话。 */
export interface ObAgentModel {
  readonly provider: string
  readonly model: string
  /** 可选的思考等级（适配器自有的档位 id）。 */
  readonly reasoningEffort?: string
}

/** 一条 Agent 条目。 */
export interface ObAgentEntry {
  /** 稳定标识，派生工具名；`^[a-z][a-z0-9_]{1,23}$` 且全局唯一。 */
  readonly id: string
  readonly kind: EntryKind
  readonly source: EntrySource
  /** 是否纳入插件管理；false = 该条目的工具完全不参与闸门与装配。 */
  readonly managed: boolean
  /** 新会话默认勾选。 */
  readonly defaultEnabled: boolean
  readonly name: string
  readonly description: string
  /** ① 给主模型：何时调用（含何时不要调用）。 */
  readonly whenPrompt: string
  /** ② 给子代理：身份提示词（仅 subagent 条目）。 */
  readonly identityPrompt?: string
  /** 子代理固定为 continuable；保留数组形状以兼容历史设置。 */
  readonly modes: readonly EntryMode[]
  readonly provider: SubagentProviderName
  readonly model?: ObAgentModel
  readonly permission: EntryPermission
  /** 覆盖全局只读白名单（仅 permission === 'readonly' 时有意义）。 */
  readonly readOnlyAllow?: readonly string[]
  /** native 条目的实现包标识。 */
  readonly impl?: NativeImpl
  /** native 条目的固定工具名（UI 只读展示）。 */
  readonly toolNames?: readonly string[]
}

/** 闸门配置：总开关关闭时模型完全不能使用 agent 类工具。 */
export interface ObAgentGate {
  /** 逃生舱：false = 完全不干预，恢复 DSH 原生行为。 */
  readonly enabled: boolean
  /** 按正则前缀命中的工具名（默认 `^subagent`）。 */
  readonly prefixes: readonly string[]
  /** 按精确名命中的工具名。 */
  readonly tools: readonly string[]
  /** 豁免名单：永不拦截的名字。 */
  readonly allow: readonly string[]
  /** 总开关打开时需要由本插件在 agent 自有层重挂的名字（继承层同名会被隐藏层屏蔽）。 */
  readonly reprovide: readonly string[]
}

/** 模型自助管理配置。 */
export interface ObAgentAuthoring {
  readonly enabled: boolean
  /** `own` = 模型只能创建/修改自己建的条目；`all` = 也能改内置与用户条目。 */
  readonly scope: 'own' | 'all'
  readonly maxEntries: number
}

/** 面向模型的文档注入方式。 */
export interface ObAgentModelGuide {
  readonly inject: 'path' | 'inline' | 'off'
}

/** 一个会话的选择状态。 */
export interface ObAgentSessionState {
  readonly enabled: boolean
  readonly selected: readonly string[]
}

/** 设置命名空间的完整形状（缺省字段由 defaults 补齐）。 */
export interface ObAgentSection {
  /** 落盘时的出厂默认版本；低于当前 `DEFAULTS_REVISION` 时由迁移改写（见 normalize.ts）。 */
  readonly defaultsRevision: number
  readonly masterEnabledDefault: boolean
  /** 启用后释放本插件的工具、闸门和提示词，由 DSH 官方管理团队。 */
  readonly teamMode: boolean
  /** 显式 DSH 数据根目录；缺省遵循宿主路径解析。 */
  readonly dshHome?: string
  readonly readOnlyTools: readonly string[]
  readonly promptVariables: readonly string[]
  readonly autoEnableControlWithContinuable: boolean
  /**
   * 在**可继续对话的子代理内部**默认放行「回发给直接父代理」的 `send_message`。
   *
   * 子代理作用域本来整片受闸门管辖（不装配任何委派或编排能力），但没有回发通道时
   * 子代理只能把结论压在最终回复里：中途发现方向错了、缺少输入、需要追加信息都传不出来。
   * 打开后只有 `send_message` 一个工具被放行，且仍由 DSH 校验相邻关系（一次性子代理
   * 与越级目标会被服务层拒绝）。
   */
  readonly childReplyToParent: boolean
  readonly gate: ObAgentGate
  readonly authoring: ObAgentAuthoring
  readonly modelGuide: ObAgentModelGuide
  /**
   * 全局子代理模型：由本插件装配的子代理在**条目未单独钉死模型**时使用。
   *
   * 缺省（`undefined`）= 继承主会话模型（宿主在启动子代理时按会话实际模型解析）。
   * 优先级固定为「条目钉死 > 全局设置 > 继承主会话」：给某个角色单独选模型仍然有效，
   * 而全局设置一次覆盖所有「跟随默认」的角色。原生 DSH 工具条目不受此字段影响：
   * 它们的模型由 DSH 自己的原生设置决定，本插件只是放行/重挂。
   */
  readonly subagentModel?: ObAgentModel
  readonly entries: readonly ObAgentEntry[]
  /** 会话 id → 选择；由浏览器经 settingsScope 写入，主机按最近使用裁剪。 */
  readonly sessions: Readonly<Record<string, ObAgentSessionState>>
}

/** 条目字段长度上限（设置页与模型工具共用同一套校验）。 */
export const ENTRY_LIMITS = {
  name: 60,
  description: 300,
  prompt: 4000,
  id: 24,
} as const

/** 条目标识允许的形状。 */
export const ENTRY_ID_PATTERN = /^[a-z][a-z0-9_]{1,23}$/

/**
 * 提示词里合法的变量引用形状。
 *
 * 必须与运行时插值器**逐字一致**：`dsh-system-prompt` 用 `GROUP_AT = /^\{\{([^{}]*)\}\}/`
 * 取花括号内的原文，再用 `VARIABLE_NAME = /^[a-z][a-z0-9_]*$/` 校验，其中任一不成立就抛错
 * 并打断整个请求。因此这里不允许空格、不允许大写开头（`{{ cwd }}`、`{{Cwd}}` 都会炸）。
 */
export const VARIABLE_PATTERN = /\{\{([a-z][a-z0-9_]*)\}\}/g

/** 由条目标识与运行模式派生工具名。 */
export function subagentToolName(id: string, _mode: EntryMode): string {
  return `subagent_${id}_session`
}

/**
 * 该条目的工具是否由 **DSH 自己**实现（而非本插件装配）。
 *
 * 界面据此把「DSH 原生工具」收进一个默认折叠的分组，避免面板被原生条目淹没。
 * `authoring` 也是 native 条目，但它的三个工具由本插件注册（属于插件自己的能力），
 * 因此不能混进那一组。
 * @param entry - 待判定的条目。
 * @returns 是 DSH 自己实现的工具条目时为 true。
 */
export function isDshProvidedEntry(entry: ObAgentEntry): boolean {
  return entry.kind === 'native' && entry.impl !== 'authoring'
}

/** 只读工具白名单的默认集（文件读取类；实际生效值是它与该作用域真实可见工具的交集）。 */
export const DEFAULT_READ_ONLY_TOOLS: readonly string[] = ['read', 'read_image', 'glob', 'grep']
/** 提示词变量白名单默认集：必须是装配里真实注册过的变量，否则渲染会抛错。 */
export const DEFAULT_PROMPT_VARIABLES: readonly string[] = ['cwd', 'model']

/** 会话选择映射保留的最大条数（按最近写入裁剪）。 */
export const MAX_SESSION_STATES = 120

/**
 * 「子代理回发给直接父代理」所用的工具名。
 *
 * 只有 `send_message`：`interrupt_agent` 的目标是「你创建的代理」，子代理没有可中断的对象，
 * 放行它只会给出一个永远失败的工具。上游 `send_message` 的目标允许是「直接父代理」
 * （仅当调用方是驻留的可继续对话子代理），相邻关系由 `ctx.subagents` 服务校验。
 */
export const CHILD_REPLY_TOOL = 'send_message'

/** 子代理续话模式：由子会话日志的 `subagent/descriptor` 折叠而来；`unknown` = 读不到。 */
export type ChildContinuationMode = 'one-shot' | 'continuable' | 'unknown'
