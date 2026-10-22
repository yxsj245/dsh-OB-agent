/**
 * 实装判定（档 A 放行 / 档 B 重挂 / 档 C 不可用）与工具配置生成的单元测试。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SECTION, UNAVAILABLE_READONLY } from '../src/defaults.ts'
import { effectiveReadOnly, effectiveSubagentModel, planNative, planSubagent, type PlanContext } from '../src/implement.ts'
import { subagentToolName } from '../src/contract.ts'
import type { ObAgentEntry } from '../src/contract.ts'

const VISIBLE = new Set(['read', 'read_image', 'glob', 'grep', 'send_message', 'interrupt_agent'])
const context = (names: Iterable<string> = VISIBLE): PlanContext => {
  const set = new Set(names)
  return { visibleTool: (name: string) => set.has(name) }
}

function entryOf(patch: Partial<ObAgentEntry>): ObAgentEntry {
  return {
    id: 'demo',
    kind: 'subagent',
    source: 'user',
    managed: true,
    defaultEnabled: false,
    name: '演示',
    description: '',
    whenPrompt: '需要时调用',
    identityPrompt: '你是演示子代理',
    modes: ['continuable'],
    provider: 'spawn',
    permission: 'full',
    ...patch,
  }
}

describe('subagentToolName', () => {
  it('按模式派生工具名', () => {
    expect(subagentToolName('code_review', 'continuable')).toBe('subagent_code_review_session')
    expect(subagentToolName('general', 'continuable')).toBe('subagent_general_session')
  })
})

describe('effectiveReadOnly', () => {
  it('只读白名单是声明值与真实可见工具的交集', () => {
    expect(effectiveReadOnly(entryOf({ permission: 'readonly' }), DEFAULT_SECTION, context(['read', 'pwsh']))).toEqual(['read'])
  })

  it('条目级白名单覆盖全局白名单', () => {
    const entry = entryOf({ permission: 'readonly', readOnlyAllow: ['grep', 'write'] })
    expect(effectiveReadOnly(entry, DEFAULT_SECTION, context(['read', 'grep', 'write']))).toEqual(['grep', 'write'])
  })
})

describe('planSubagent', () => {
  it('完全权限下不生成工具白名单，并按模式生成配置', () => {
    const result = planSubagent(entryOf({}), 'continuable', DEFAULT_SECTION, context())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.kind).toBe('subagent')
    if (result.plan.kind !== 'subagent') return
    expect(result.plan.toolName).toBe('subagent_demo_session')
    expect(result.plan.config).toMatchObject({ provider: 'spawn' })
    expect(result.plan.config).not.toHaveProperty('maxDepth')
    expect(result.plan.identityPrompt).toBe('你是演示子代理')
    expect(result.plan.config).not.toHaveProperty('persona')
    expect(result.plan.config).not.toHaveProperty('toolFilter')
    expect(result.plan.readOnlyAllow).toBeUndefined()
    expect(result.plan.config.agentOptions).toBeUndefined()
  })

  it('可继续对话模式与钉死模型一起进入配置', () => {
    const entry = entryOf({ modes: ['continuable'], model: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
    const result = planSubagent(entry, 'continuable', DEFAULT_SECTION, context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.plan.kind !== 'subagent') return
    expect(result.plan.toolName).toBe('subagent_demo_session')
    expect(result.plan.mode).toBe('continuable')
    expect(result.plan.config).not.toHaveProperty('backgroundMode')
    expect(result.plan.config.agentOptions).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('只读权限把交集写进工具白名单', () => {
    const result = planSubagent(entryOf({ permission: 'readonly' }), 'continuable', DEFAULT_SECTION, context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.plan.kind !== 'subagent') return
    expect(result.plan.readOnlyAllow).toEqual(['read', 'read_image', 'glob', 'grep', 'send_message'])
    expect(result.plan.config).not.toHaveProperty('toolFilter')
  })

  it('只读交集为空时判定为不可用，且不降级为完全权限', () => {
    const result = planSubagent(entryOf({ permission: 'readonly' }), 'continuable', DEFAULT_SECTION, context(['pwsh']))
    expect(result).toEqual({ ok: false, reason: UNAVAILABLE_READONLY })
  })

  it('fork 后端同样受支持', () => {
    const result = planSubagent(entryOf({ provider: 'fork' }), 'continuable', DEFAULT_SECTION, context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.plan.kind !== 'subagent') return
    expect(result.plan.config.provider).toBe('fork')
  })
})

describe('planNative', () => {
  const natives = DEFAULT_SECTION.entries.filter(entry => entry.kind === 'native')

  it('继承面已提供时判为放行（不发生重复注册）', () => {
    const control = natives.find(entry => entry.id === 'agents_control')
    expect(control).toBeDefined()
    const result = planNative(control as ObAgentEntry, context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.plan.kind !== 'native') return
    expect(result.plan.action).toBe('passthrough')
    expect(result.plan.toolNames).toEqual(['send_message', 'interrupt_agent'])
  })

  it('继承面缺失时判为本层重挂', () => {
    const workflow = natives.find(entry => entry.id === 'workflow')
    const result = planNative(workflow as ObAgentEntry, context(['read']))
    expect(result.ok).toBe(true)
    if (!result.ok || result.plan.kind !== 'native') return
    expect(result.plan.action).toBe('install')
  })

  it('自助管理条目由本插件自己注册', () => {
    const authoring = natives.find(entry => entry.id === 'agent_authoring')
    const result = planNative(authoring as ObAgentEntry, context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.plan.kind !== 'native') return
    expect(result.plan.action).toBe('plugin')
  })

  it('清单条目即使继承层已可见也判为重挂（改写结果必须自己持有工具）', () => {
    const list = natives.find(entry => entry.id === 'agents_list')
    expect(list).toBeDefined()
    // 继承层可见（原生已全局装配）时其它原生条目走 passthrough，但清单条目必须 install：
    // 否则首轮放行会绕过结果改写，能力清单要等第二轮重算才出现。
    expect(planNative(list as ObAgentEntry, context(['list_agents'])).ok).toBe(true)
    const visible = planNative(list as ObAgentEntry, context(['list_agents']))
    const hidden = planNative(list as ObAgentEntry, context([]))
    if (visible.ok && visible.plan.kind === 'native') expect(visible.plan.action).toBe('install')
    if (hidden.ok && hidden.plan.kind === 'native') expect(hidden.plan.action).toBe('install')
  })

  it('预设具名子代理条目只放行可见的那部分', () => {
    const preset = natives.find(entry => entry.id === 'subagent_native')
    expect(preset?.toolNames).toEqual(['subagent_hy4'])
    const visible = planNative(preset as ObAgentEntry, context(['subagent_hy4', 'read']))
    expect(visible.ok).toBe(true)
    if (visible.ok && visible.plan.kind === 'native') expect(visible.plan.action).toBe('passthrough')
    const hidden = planNative(preset as ObAgentEntry, context(['read']))
    expect(hidden.ok).toBe(false)
  })

  it('缺少实现标识或工具名时判定为不可用', () => {
    const broken = entryOf({ kind: 'native', impl: undefined, toolNames: undefined })
    expect(planNative(broken, context()).ok).toBe(false)
    const noNames = entryOf({ kind: 'native', impl: 'workflow', toolNames: [] })
    expect(planNative(noNames, context()).ok).toBe(false)
  })
})

describe('全局子代理模型', () => {
  const globalModel = { provider: 'gp', model: 'gm', reasoningEffort: 'low' }
  const withGlobal = { ...DEFAULT_SECTION, subagentModel: globalModel }

  it('条目未钉死模型时使用全局模型（并带上全局档位）', () => {
    expect(effectiveSubagentModel(entryOf({}), withGlobal)).toEqual(globalModel)
    const result = planSubagent(entryOf({}), 'continuable', withGlobal, context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.plan.kind !== 'subagent') return
    expect(result.plan.config.agentOptions).toEqual({ provider: 'gp', model: 'gm', reasoningEffort: 'low' })
  })

  it('条目钉死的模型优先于全局模型（固定角色可复现）', () => {
    const entry = entryOf({ model: { provider: 'ep', model: 'em' } })
    expect(effectiveSubagentModel(entry, withGlobal)).toEqual({ provider: 'ep', model: 'em' })
    const result = planSubagent(entry, 'continuable', withGlobal, context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.plan.kind !== 'subagent') return
    expect(result.plan.config.agentOptions).toEqual({ provider: 'ep', model: 'em' })
  })

  it('没有全局模型时保持继承主会话：不写 agentOptions', () => {
    expect(effectiveSubagentModel(entryOf({}), DEFAULT_SECTION)).toBeUndefined()
    const result = planSubagent(entryOf({}), 'continuable', DEFAULT_SECTION, context())
    expect(result.ok).toBe(true)
    if (!result.ok || result.plan.kind !== 'subagent') return
    expect(result.plan.config.agentOptions).toBeUndefined()
  })
})
