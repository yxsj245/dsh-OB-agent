/**
 * dsh-ob-agent 主机插件：把 DSH 的全部 agent 类工具收口到一处统一管理。
 *
 * 职责：
 * - 读取插件 live Config `section`（条目表、闸门名单、自助管理开关等）；
 * - 在 `agent/created` 上为每个 agent 建立协调状态：执行层守卫 + 隐藏层 +
 *   按勾选装配工具 + 每会话的「Agent 工具信息」系统提示段；
 * - 设置变更、工具集变更、agent 生命周期变化时重算（幂等，只增删差异项）。
 *
 * 会话级选择存放在 Config `section.sessions` 映射里（键为会话 id），由浏览器经
 * `configForms` 写入；主机读取同一份 live Config。
 */
import type { AgentLike, AgentRegistryLike, ConfigEditorLike, HostContext } from './context-types.ts'
import { readSection } from './normalize.ts'
import { Config, type PluginConfig } from './settings.ts'
import { disposeAgent, reconcileAgent, type ReconcileDeps } from './reconcile.ts'
import type { ObAgentSection } from './contract.ts'
import { installChildPolicies } from './subagent-compat.ts'

/** Cordis 插件名（Loader 入口与客户端 bundle id）。 */
export const name = 'dsh-ob-agent'

/** 必需服务：全部按需注入（见 apply），因此这里声明为空。 */
export const inject: string[] = []

/** 配置由 Schemastery 的 Config 导出定义。 */
export { Config }

/**
 * 插件体。
 * @param ctx - 主机 cordis 上下文。
 */
export function apply(ctx: HostContext, config: PluginConfig): void {
  // 安全策略必须先于异步协调器完成，读取失败会否决插件子代理的发布。
  let section: ObAgentSection = readPluginConfig(config)
  installChildPolicies(ctx, () => section.dshHome)
  let scope: { update(patch: object): Promise<void> } | undefined
  let queued = false
  let active = true
  const ownedAgents = new Set<AgentLike>()
  ctx.effect(() => () => {
    active = false
    const agents = [...ownedAgents]
    ownedAgents.clear()
    return Promise.all(agents.map(agent => disposeAgent(agent))).then(() => undefined)
  }, 'dsh-ob-agent: scoped registrations')

  /** 读取当前 live Config（设置未就绪时给出厂默认）。 */
  const read = (): ObAgentSection => section

  const deps: ReconcileDeps = {
    ctx,
    read,
    get scope() {
      return scope
    },
  }

  /** 全量重算所有顶层与子代理（幂等；并发由协调器内部折叠）。 */
  const runAll = async (): Promise<void> => {
    if (!active) return
    const agents = ctx.get('agents') as AgentRegistryLike | undefined
    if (agents === undefined) return
    await Promise.all(agents.list().map(async agent => {
      ownedAgents.add(agent)
      try {
        await reconcileAgent(deps, agent)
      } catch (error) {
        ctx.logger.warn(
          `dsh-ob-agent: 协调 agent ${agent.id} 失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }))
  }

  /** 合并同一轮内的多次触发（设置提交、工具变更、agent 创建）。 */
  const schedule = (): void => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      void runAll()
    })
  }

  ctx.on('settings/document-updated', async (entryId: string) => {
    if (entryId !== 'dsh-ob-agent') return
    const parsed = readPluginConfig(config)
    const errors = validate(parsed)
    if (errors.length > 0) {
      ctx.logger.warn(`dsh-ob-agent: 插件配置存在问题（已按可用部分继续）：${errors.join('；')}`)
    }
    section = parsed
    await runAll()
  })

  ctx.inject(['configEditor'], (editorCtx) => {
    const editor = editorCtx.get('configEditor') as ConfigEditorLike | undefined
    const entry = ctx.fiber?.entry
    if (editor === undefined || entry === undefined) {
      ctx.logger.warn('dsh-ob-agent: 配置编辑器不可用，模型自助管理暂不可写')
      return
    }
    const writer = {
      update: async (patch: object): Promise<void> => {
        await editor.edit(entry, current => ({
          ...current,
          ...patch,
        }))
      },
    }
    editorCtx.effect(() => {
      scope = writer
      schedule()
      return () => {
        if (scope === writer) scope = undefined
      }
    }, 'dsh-ob-agent: config editor')
  })

  // agent 生命周期：创建即装配；销毁即释放（协调状态同时由 WeakMap 回收）。
  ctx.on('agent/created', async (payload: { agent: AgentLike }) => {
    try {
      // 新版宿主串行等待创建监听；首个模型请求前完成工具装配。安全策略由前置监听独立否决。
      const agent = payload?.agent
      if (agent === undefined || !active) return
      ownedAgents.add(agent)
      await reconcileAgent(deps, agent).catch(error => {
        ctx.logger.warn(
          `dsh-ob-agent: 初始化 agent ${agent.id} 失败：${error instanceof Error ? error.message : String(error)}`,
        )
      })
    } catch (error) {
      ctx.logger.error(`dsh-ob-agent: agent/created 处理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.on('agent/disposed', (payload: { agent: AgentLike }) => {
    const agent = payload?.agent
    if (agent === undefined) return
    ownedAgents.delete(agent)
    void disposeAgent(agent)
  })

  // 工具集变化（预设切换、MCP 上下线、本插件自身的装配）→ 重算。幂等保证不成环。
  ctx.on('tools/change', () => schedule())
  ctx.on('subagent/provider-added', () => schedule())
  ctx.on('subagent/provider-removed', () => schedule())

  ctx.inject(['agentTeams'], teamCtx => {
    // 服务先就绪时即释放 OB 工具；冷启动与官方入口启用都走同一避让路径。
    void runAll()
    teamCtx.effect(() => () => schedule(), 'dsh-ob-agent: team handoff')
  })

  // 首次装配：已有 agent（HMR / 重新挂载）也要纳入管理。
  schedule()
}

function readPluginConfig(config: PluginConfig): ObAgentSection {
  return readSection({
    defaultsRevision: config.defaultsRevision.get(),
    masterEnabledDefault: config.masterEnabledDefault.get(),
    teamMode: config.teamMode.get(),
    dshHome: config.dshHome?.get(),
    readOnlyTools: config.readOnlyTools.get(),
    promptVariables: config.promptVariables.get(),
    autoEnableControlWithContinuable: config.autoEnableControlWithContinuable.get(),
    childReplyToParent: config.childReplyToParent.get(),
    gate: config.gate.get(),
    authoring: config.authoring.get(),
    modelGuide: config.modelGuide.get(),
    subagentModel: config.subagentModel.get(),
    entries: config.entries.get(),
    sessions: config.sessions.get(),
  })
}

/** 校验设置段的最小不变量；只告警不阻断（用户的半成品配置不应让插件失效）。 */
function validate(section: ObAgentSection): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const entry of section.entries) {
    if (seen.has(entry.id)) errors.push(`条目标识重复：${entry.id}`)
    seen.add(entry.id)
  }
  if (section.entries.length === 0) errors.push('条目表为空，已回退为无任何 Agent 工具')
  return errors
}
