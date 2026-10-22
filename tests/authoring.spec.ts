/**
 * 模型自助管理工具的单元测试：参数契约（严格校验、真正的部分更新）、写入护栏
 * （团队模式 / 作用域 / 上限）与结果文案（清单与可用性口径）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SECTION } from '../src/defaults.ts'
import { authoringTools, entryFromArgs, parameterSchemaOf, type AuthoringDeps } from '../src/authoring.ts'
import { readSection } from '../src/normalize.ts'
import type { ToolDefinitionLike, ToolExecLike } from '../src/context-types.ts'
import type { ObAgentEntry, ObAgentSection } from '../src/contract.ts'

interface Harness {
  readonly tools: ToolDefinitionLike[]
  readonly writes: Record<string, unknown>[]
  readonly audits: string[]
  readonly deps: AuthoringDeps
  setSection(next: ObAgentSection): void
}

/** 本会话记录形状（仅测试断言用）。 */
type Sessions = Record<string, { enabled: boolean; selected: string[] }>

/** 造一台「假主机」：设置读写与审计都被记录下来。 */
function harness(raw: Record<string, unknown> = {}): Harness {
  let section = readSection({ ...DEFAULT_SECTION, ...raw })
  const writes: Record<string, unknown>[] = []
  const audits: string[] = []
  const deps: AuthoringDeps = {
    read: () => section,
    scope: {
      update: (patch: object) => {
        writes.push(patch as Record<string, unknown>)
        return Promise.resolve()
      },
    },
    audit: message => { audits.push(message) },
    sessionIdOf: agent => agent?.session.id,
    docHint: () => 'D:/plugin/docs/model-guide.md',
  }
  return {
    tools: authoringTools(deps),
    writes,
    audits,
    deps,
    setSection: (next) => { section = next },
  }
}

function toolOf(tools: readonly ToolDefinitionLike[], name: string): ToolDefinitionLike {
  const found = tools.find(tool => tool.name === name)
  if (found === undefined) throw new Error(`缺少工具 ${name}`)
  return found
}

/** 直接调用解析层：预期被拒绝并返回全部中文原因。 */
function errorsOf(args: Record<string, unknown>, base?: ObAgentEntry): readonly string[] {
  const result = entryFromArgs(args, base)
  if (result.ok) throw new Error('预期被拒绝，但解析成功')
  return result.errors
}

/** 直接调用解析层：预期成功并返回条目。 */
function entryOf(args: Record<string, unknown>, base?: ObAgentEntry): ObAgentEntry {
  const result = entryFromArgs(args, base)
  if (!result.ok) throw new Error(`预期成功，但被拒绝：${result.errors.join('；')}`)
  return result.entry
}

/** 三工具共有的字段名（创建与更新的属性集合必须一致，只有必填项不同）。 */
const ALL_FIELDS = [
  'defaultEnabled', 'description', 'enableNow', 'id', 'identityPrompt', 'inheritModel', 'model',
  'modelProvider', 'modes', 'name', 'permission', 'provider', 'readOnlyAllow', 'reasoningEffort', 'whenPrompt',
]

/** 一条已经钉死路由与档位的条目（部分更新的基准）。 */
const PINNED: ObAgentEntry = {
  id: 'pinned_agent',
  kind: 'subagent',
  source: 'model',
  managed: true,
  defaultEnabled: false,
  name: '钉死路由',
  description: '描述',
  whenPrompt: 'a',
  identityPrompt: 'b',
  modes: ['continuable'],
  provider: 'spawn',
  model: { provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' },
  permission: 'full',
}

const exec: ToolExecLike = { agent: { session: { id: 's1' } } as never }

describe('entryFromArgs：部分更新', () => {
  it('省略字段时保留固定路由与思考档位（回归：曾静默清空 model 变成继承）', () => {
    const entry = entryOf({}, PINNED)
    expect(entry.model).toEqual({ provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' })
    expect(entry.name).toBe(PINNED.name)
    expect(entry.source).toBe('model')
  })

  it('只改描述时其余字段（含纳管状态与来源）原样保留', () => {
    const entry = entryOf({ id: 'pinned_agent', description: '新描述' }, { ...PINNED, managed: false, source: 'user' })
    expect(entry.description).toBe('新描述')
    expect(entry.managed).toBe(false)
    expect(entry.source).toBe('user')
    expect(entry.model).toEqual(PINNED.model)
  })

  it('切换路由且未给档位时不继承旧路由的档位', () => {
    const entry = entryOf({ modelProvider: 'qwen-token-plan-cn', model: 'qwen3.8-max' }, PINNED)
    expect(entry.model).toEqual({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-max' })
  })

  it('路由保持不变时保留档位；只给档位时改档位', () => {
    const same = entryOf({ modelProvider: 'zai', model: 'glm-5.3-flash' }, PINNED)
    expect(same.model).toEqual({ provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' })
    const effortOnly = entryOf({ reasoningEffort: 'max' }, PINNED)
    expect(effortOnly.model).toEqual({ provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'max' })
  })

  it('档位传空串表示显式清除', () => {
    expect(entryOf({ reasoningEffort: '' }, PINNED).model).toEqual({ provider: 'zai', model: 'glm-5.3-flash' })
  })

  it('inheritModel=true 显式恢复继承，且不能被漏传字段兼任', () => {
    expect(entryOf({ inheritModel: true }, PINNED).model).toBeUndefined()
    expect(entryOf({ inheritModel: false }, PINNED).model).toEqual(PINNED.model)
  })
})

describe('entryFromArgs：严格校验（不静默降级）', () => {
  it('缺 id 或 id 形状错误时给出中文原因', () => {
    expect(errorsOf({ name: 'x' })).toContain('缺少 id')
    expect(errorsOf({ id: 42 })).toContain('参数 id 必须是 2-24 位、小写字母开头的非空字符串')
  })

  it('模型路由必须成对给出，半填与空串都报错', () => {
    expect(errorsOf({ id: 'demo_agent', modelProvider: 'zai' }).join('；')).toContain('modelProvider 与 model 必须成对给出')
    expect(errorsOf({ id: 'demo_agent', model: 'glm-5.3-flash' }).join('；')).toContain('必须成对给出')
    expect(errorsOf({ id: 'demo_agent', modelProvider: 'zai', model: '  ' }).join('；')).toContain('都不能为空')
  })

  it('inheritModel 与路由字段互斥，且不能同时设档位', () => {
    expect(errorsOf({ id: 'demo_agent', inheritModel: true, modelProvider: 'zai', model: 'glm-5.3-flash' }).join('；'))
      .toContain('互斥')
    expect(errorsOf({ id: 'demo_agent', inheritModel: true, reasoningEffort: 'high' }).join('；'))
      .toContain('不能同时设置 reasoningEffort')
  })

  it('未钉死路由时不能设置档位', () => {
    expect(errorsOf({ id: 'demo_agent', reasoningEffort: 'high' }).join('；'))
      .toContain('未钉死模型路由时不能设置 reasoningEffort')
  })

  it('枚举与类型错误一律拒绝（不再静默落回默认值）', () => {
    const errorsOfOne = (args: Record<string, unknown>): string => errorsOf({ id: 'demo_agent', ...args }).join('；')
    expect(errorsOfOne({ provider: 'spawn2' })).toContain('参数 provider 只接受 spawn')
    expect(errorsOfOne({ permission: 'readonly2' })).toContain('参数 permission 只接受 full')
    expect(errorsOfOne({ modes: [] })).toContain('不能给空数组')
    expect(errorsOfOne({ modes: 'continuable' })).toContain('必须是数组')
    expect(errorsOfOne({ modes: ['one-shot'] })).toContain('只支持 continuable')
    expect(errorsOfOne({ readOnlyAllow: 'read' })).toContain('必须是工具名数组')
    expect(errorsOfOne({ readOnlyAllow: ['read', ''] })).toContain('只能包含非空工具名字符串')
    expect(errorsOfOne({ defaultEnabled: 'yes' })).toContain('参数 defaultEnabled 必须是布尔值')
    expect(errorsOfOne({ enableNow: 1 })).toContain('参数 enableNow 必须是布尔值')
    expect(errorsOfOne({ name: 3 })).toContain('参数 name 必须是字符串')
    expect(errorsOfOne({ inheritModel: 'true' })).toContain('参数 inheritModel 必须是布尔值')
  })

  it('新建条目缺名称或身份提示词时给出明确原因', () => {
    expect(errorsOf({ id: 'demo_agent' })[0]).toContain('新建条目必须给出合法的 id、非空名称与身份提示词')
  })

  it('一次调用收集多条错误，模型能一次改完', () => {
    const errors = errorsOf({
      id: 'demo_agent',
      provider: 'bad',
      permission: 'bad',
      modes: ['one-shot'],
      defaultEnabled: 'yes',
    })
    expect(errors.length).toBeGreaterThanOrEqual(4)
  })
})

describe('agent_list 可用性口径', () => {
  it('列出模型/档位/权限/上下文与默认勾选', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: ['general'] } } })
    // 用一条模型自建、钉死路由与档位的条目来核对清单字段（内置条目的默认路由会随出厂表变化）。
    await toolOf(h.tools, 'agent_create').execute({
      id: 'pinned_agent',
      name: '钉死路由',
      whenPrompt: 'a',
      identityPrompt: 'b',
      permission: 'readonly',
      provider: 'fork',
      modelProvider: 'zai',
      model: 'glm-5.3-flash',
      reasoningEffort: 'high',
    }, exec)
    h.setSection(readSection({
      ...DEFAULT_SECTION,
      sessions: { s1: { enabled: true, selected: ['general'] } },
      entries: h.writes[0]?.entries as ObAgentEntry[],
    }))

    const text = String(await toolOf(h.tools, 'agent_list').execute({}, exec))
    expect(text).toContain('code_review')
    expect(text).toContain('本会话已启用')
    expect(text).toContain('本会话未启用')
    expect(text).toContain('模型：zai / glm-5.3-flash（档位 high）')
    expect(text).toContain('权限：只读')
    expect(text).toContain('上下文：继承本会话已完成轮次')
    expect(text).toContain('模型：继承主会话')
    expect(text).toContain('默认勾选：否')
    expect(text).toContain('总开关默认：关')
    expect(text).toContain('条目上限：24 条')
  })

  it('总开关关闭时不得把已勾选条目说成已启用', async () => {
    const h = harness({ sessions: { s1: { enabled: false, selected: ['general'] } } })
    const text = String(await toolOf(h.tools, 'agent_list').execute({}, exec))
    expect(text).not.toContain('本会话已启用')
    expect(text).toContain('不可用（本会话「子代理」总开关关闭）')
  })

  it('无本会话记录时按默认勾选判定（出厂总开关默认开时）', async () => {
    const h = harness({ masterEnabledDefault: true })
    const text = String(await toolOf(h.tools, 'agent_list').execute({}, exec))
    expect(text).toContain('本会话已启用')
    expect(text).toContain('本会话未启用')
  })

  it('闸门逃生舱打开时说明「未纳管」而不是「未启用」', async () => {
    const h = harness({ gate: { ...DEFAULT_SECTION.gate, enabled: false } })
    const text = String(await toolOf(h.tools, 'agent_list').execute({}, exec))
    expect(text).toContain('闸门已关闭')
    expect(text).not.toContain('本会话未启用')
  })
})

describe('agent_create', () => {
  const args = {
    id: 'doc_writer',
    name: '文档撰写',
    whenPrompt: '需要写使用文档时调用',
    identityPrompt: '你是文档撰写子代理',
  }

  it('写入新条目（source=model）并给出「下一轮可用」提示与审计', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: [] } } })
    const text = String(await toolOf(h.tools, 'agent_create').execute(args, exec))
    expect(h.writes).toHaveLength(1)
    const entries = h.writes[0]?.entries as ObAgentEntry[]
    expect(entries).toHaveLength(DEFAULT_SECTION.entries.length + 1)
    const created = entries.find(entry => entry.id === 'doc_writer')
    expect(created?.source).toBe('model')
    expect(created?.modes).toEqual(['continuable'])
    expect(text).toContain('下一轮请求')
    expect(text).toContain('模型：继承主会话')
    expect(h.audits[0]).toContain('doc_writer')
  })

  it('本会话没有记录时，首次 enableNow 保留出厂默认勾选（回归：曾把默认勾选静默取消）', async () => {
    const h = harness()
    await toolOf(h.tools, 'agent_create').execute(args, exec)
    const sessions = h.writes[0]?.sessions as Sessions
    const expectedDefaults = DEFAULT_SECTION.entries
      .filter(entry => entry.managed && entry.defaultEnabled)
      .map(entry => entry.id)
    expect(expectedDefaults.length).toBeGreaterThan(0)
    expect([...(sessions.s1?.selected ?? [])].sort()).toEqual([...expectedDefaults, 'doc_writer'].sort())
    expect(sessions.s1?.enabled).toBe(false)
  })

  it('已存在的本会话记录不会被默认勾选覆盖（尊重用户显式选择）', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: [] } } })
    await toolOf(h.tools, 'agent_create').execute(args, exec)
    const sessions = h.writes[0]?.sessions as Sessions
    expect(sessions.s1?.selected).toEqual(['doc_writer'])
    expect(sessions.s1?.enabled).toBe(true)
  })

  it('enableNow=false 时既不写会话记录也不声称已启用', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: [] } } })
    const text = String(await toolOf(h.tools, 'agent_create').execute({ ...args, enableNow: false }, exec))
    expect(h.writes[0]?.sessions).toBeUndefined()
    expect(text).toContain('未在本会话启用')
  })

  it('总开关关闭时写入勾选但不声称可用', async () => {
    const h = harness({ sessions: { s1: { enabled: false, selected: [] } } })
    const text = String(await toolOf(h.tools, 'agent_create').execute(args, exec))
    const sessions = h.writes[0]?.sessions as Sessions
    expect(sessions.s1?.selected).toEqual(['doc_writer'])
    expect(sessions.s1?.enabled).toBe(false)
    expect(text).toContain('总开关')
  })

  it('标识冲突时拒绝写入并提示先查重', async () => {
    const h = harness()
    const text = String(await toolOf(h.tools, 'agent_create').execute({ ...args, id: 'general' }, exec))
    expect(text).toContain('已被占用')
    expect(h.writes).toHaveLength(0)
  })

  it('未知提示词变量被拒绝', async () => {
    const h = harness()
    const text = String(await toolOf(h.tools, 'agent_create').execute({ ...args, whenPrompt: '见 {{nope}}' }, exec))
    expect(text).toContain('{{nope}}')
    expect(h.writes).toHaveLength(0)
  })

  it('非法枚举与类型在工具层同样被拒绝且不写入', async () => {
    const h = harness()
    for (const bad of [{ permission: 'readonly2' }, { provider: 'spawn2' }, { modelProvider: 'zai' }, { defaultEnabled: 'yes' }]) {
      const text = String(await toolOf(h.tools, 'agent_create').execute({ ...args, ...bad }, exec))
      expect(text).toContain('操作被拒绝')
    }
    expect(h.writes).toHaveLength(0)
  })

  it('只读权限且交集为空时仍可创建（可见性在装配期判定），但缺白名单会被拒', async () => {
    const h = harness({ readOnlyTools: [] })
    const text = String(await toolOf(h.tools, 'agent_create').execute({ ...args, permission: 'readonly' }, exec))
    expect(text).toContain('只读权限需要非空的只读工具白名单')
    expect(h.writes).toHaveLength(0)
  })

  it('达到条目上限时拒绝', async () => {
    const h = harness({ authoring: { ...DEFAULT_SECTION.authoring, maxEntries: DEFAULT_SECTION.entries.length } })
    const text = String(await toolOf(h.tools, 'agent_create').execute(args, exec))
    expect(text).toContain('已达上限')
    expect(h.writes).toHaveLength(0)
  })

  it('自助管理被关闭时拒绝', async () => {
    const h = harness({ authoring: { ...DEFAULT_SECTION.authoring, enabled: false } })
    const text = String(await toolOf(h.tools, 'agent_create').execute(args, exec))
    expect(text).toContain('已被用户关闭')
    expect(h.writes).toHaveLength(0)
  })
})

describe('agent_update', () => {
  /** 造一个已存在的模型自建条目并切到它之后的设置段。 */
  async function withCreatedEntry(h: Harness, extra: Record<string, unknown> = {}): Promise<void> {
    await toolOf(h.tools, 'agent_create').execute({
      id: 'tmp_agent',
      name: '临时',
      whenPrompt: 'a',
      identityPrompt: 'b',
      ...extra,
    }, exec)
    const created = h.writes[0]?.entries as ObAgentEntry[]
    h.setSection(readSection({ ...DEFAULT_SECTION, entries: created }))
  }

  it('默认作用域下拒绝修改内置条目', async () => {
    const h = harness()
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'code_review', name: '改名' }, exec))
    expect(text).toContain('不是模型创建的条目')
    expect(h.writes).toHaveLength(0)
  })

  it('只给要改的字段即可修改模型自建条目，并保留固定路由与档位', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: [] } } })
    await withCreatedEntry(h, { modelProvider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' })
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'tmp_agent', description: '新描述' }, exec))
    expect(text).toContain('已保存')
    expect(text).toContain('模型：zai / glm-5.3-flash（档位 high）')
    const updated = h.writes[1]?.entries as ObAgentEntry[]
    const entry = updated.find(item => item.id === 'tmp_agent')
    expect(entry?.description).toBe('新描述')
    expect(entry?.model).toEqual({ provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' })
    expect(h.audits[1]).toContain('来源保持模型自建')
  })

  it('切路由未给档位时不带旧档位，显式 inheritModel 才恢复继承', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: [] } } })
    await withCreatedEntry(h, { modelProvider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'high' })
    await toolOf(h.tools, 'agent_update').execute({ id: 'tmp_agent', modelProvider: 'qwen-token-plan-cn', model: 'qwen3.8-max' }, exec)
    const switched = (h.writes[1]?.entries as ObAgentEntry[]).find(item => item.id === 'tmp_agent')
    expect(switched?.model).toEqual({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-max' })
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'tmp_agent', inheritModel: true }, exec))
    expect(text).toContain('模型：继承主会话')
    const inherited = (h.writes[2]?.entries as ObAgentEntry[]).find(item => item.id === 'tmp_agent')
    expect(inherited?.model).toBeUndefined()
  })

  it('半填模型路由被拒绝且不写入', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: [] } } })
    await withCreatedEntry(h)
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'tmp_agent', modelProvider: 'zai' }, exec))
    expect(text).toContain('必须成对给出')
    expect(h.writes).toHaveLength(1)
  })

  it('作用域为 all 时可修改内置条目的可编辑字段', async () => {
    const h = harness({ authoring: { ...DEFAULT_SECTION.authoring, scope: 'all' } })
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'code_review', description: '新描述' }, exec))
    expect(text).toContain('已保存')
    const updated = h.writes[0]?.entries as ObAgentEntry[]
    expect(updated.find(entry => entry.id === 'code_review')?.description).toBe('新描述')
  })

  it('作用域为 all 时改写内置条目仍保留 source=builtin（防止作用域收回后越权）', async () => {
    const all = harness({ authoring: { ...DEFAULT_SECTION.authoring, scope: 'all' } })
    await toolOf(all.tools, 'agent_update').execute({ id: 'code_review', description: '新描述' }, exec)
    const updated = all.writes[0]?.entries as ObAgentEntry[]
    expect(updated.find(entry => entry.id === 'code_review')?.source).toBe('builtin')

    // 同一份设置段换成默认作用域（own）：模型依然改不动这条内置条目。
    const own = harness({ entries: updated })
    const text = String(await toolOf(own.tools, 'agent_update').execute({ id: 'code_review', description: '再次改' }, exec))
    expect(text).toContain('不是模型创建的条目')
    expect(own.writes).toHaveLength(0)
  })

  it('原生工具条目不能按子代理字段修改', async () => {
    const h = harness({ authoring: { ...DEFAULT_SECTION.authoring, scope: 'all' } })
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'workflow', name: 'x' }, exec))
    expect(text).toContain('DSH 原生工具条目')
    expect(h.writes).toHaveLength(0)
  })

  it('不存在的条目给出查重提示', async () => {
    const h = harness()
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'nope', name: 'x' }, exec))
    expect(text).toContain('没有这个条目')
  })

  it('enableNow：更新时补勾选、已勾选不重复写、false 不动勾选', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: [] } } })
    await withCreatedEntry(h)
    await toolOf(h.tools, 'agent_update').execute({ id: 'tmp_agent', description: 'x' }, exec)
    const sessions = h.writes[1]?.sessions as Sessions | undefined
    expect(sessions?.s1?.selected).toContain('tmp_agent')

    h.setSection(readSection({
      ...DEFAULT_SECTION,
      sessions: { s1: { enabled: true, selected: ['tmp_agent'] } },
      entries: h.writes[1]?.entries as ObAgentEntry[],
    }))
    await toolOf(h.tools, 'agent_update').execute({ id: 'tmp_agent', description: 'y' }, exec)
    expect(h.writes[2]?.sessions).toBeUndefined()

    await toolOf(h.tools, 'agent_update').execute({ id: 'tmp_agent', description: 'z', enableNow: false }, exec)
    expect(h.writes[3]?.sessions).toBeUndefined()
  })
})

describe('团队模式', () => {
  it('创建与更新都被拒绝，读清单不受影响', async () => {
    const h = harness({ teamMode: true, sessions: { s1: { enabled: true, selected: ['general'] } } })
    const createText = String(await toolOf(h.tools, 'agent_create').execute({
      id: 'doc_writer',
      name: '文档撰写',
      whenPrompt: 'a',
      identityPrompt: 'b',
    }, exec))
    expect(createText).toContain('团队模式已开启')
    const updateText = String(await toolOf(h.tools, 'agent_update').execute({ id: 'general', description: 'x' }, exec))
    expect(updateText).toContain('团队模式已开启')
    expect(h.writes).toHaveLength(0)
    expect(h.audits).toHaveLength(0)

    const listText = String(await toolOf(h.tools, 'agent_list').execute({}, exec))
    expect(listText).toContain('团队模式已开启')
    expect(listText).toContain('general')
  })
})

describe('工具定义自身', () => {
  it('三个工具都声明了输出渲染与并发分类', () => {
    const h = harness()
    expect(h.tools.map(tool => tool.name)).toEqual(['agent_create', 'agent_update', 'agent_list'])
    for (const tool of h.tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.output.render({}, 'x')).toEqual([{ type: 'text', text: 'x' }])
    }
    expect(toolOf(h.tools, 'agent_list').isConcurrencySafe?.({})).toBe(true)
    expect(toolOf(h.tools, 'agent_create').isConcurrencySafe?.({})).toBe(false)
  })

  it('参数模式是模型可见的 JSON Schema（根为 object），不是作者侧属性表', () => {
    // 上游 `ToolSchema.parameters` 的契约是 JSON Schema；直接把属性表注册上去不会报错，
    // 只会静默降级：Anthropic 系 provider 因 input_schema 非 object 拒绝，OpenAI 系则把
    // 字段名当未知关键字。这条断言就是防止再次退化。
    const h = harness()
    const create = toolOf(h.tools, 'agent_create').parameters
    expect(create.type).toBe('object')
    const props = create.properties as Record<string, Record<string, unknown>>
    expect(Object.keys(props).sort()).toEqual(ALL_FIELDS)
    expect(create.required).toEqual(['id', 'name', 'whenPrompt', 'identityPrompt'])
    // 属性表里的 `required: true` 必须被搬进根 required 数组，不能留在属性定义里
    for (const property of Object.values(props)) expect(property.required).toBeUndefined()
    expect(props.id?.type).toBe('string')
    expect(props.modes?.type).toBe('array')
    // 枚举与档位字段必须是模型可见的约束
    expect(props.provider?.enum).toEqual(['spawn', 'fork'])
    expect(props.permission?.enum).toEqual(['full', 'readonly'])

    const list = toolOf(h.tools, 'agent_list').parameters
    expect(list).toEqual({ type: 'object', properties: {} })
  })

  it('agent_update 只有 id 必填，其余字段省略即保持（回归：曾要求 name/whenPrompt/identityPrompt）', () => {
    const update = toolOf(harness().tools, 'agent_update').parameters
    expect(update.required).toEqual(['id'])
    const props = update.properties as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(ALL_FIELDS)
    // 可改的字段必须都在：只去掉必填，不是把字段从 Schema 里删掉
    for (const field of ['name', 'whenPrompt', 'identityPrompt']) expect(props[field]).toBeDefined()
    for (const property of Object.values(props)) {
      expect((property as Record<string, unknown>).required).toBeUndefined()
    }
  })

  it('parameterSchemaOf 保留非对象字段定义并忽略非 true 的 required', () => {
    const schema = parameterSchemaOf({
      a: { type: 'string', required: true },
      b: { type: 'number', required: false },
      c: { type: 'boolean' },
    })
    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } },
      required: ['a'],
    })
  })
})

describe('全局子代理模型对模型自助面的可见性', () => {
  it('agent_list 单列全局模型，未钉死条目显示「跟随全局」', async () => {
    const h = harness({
      subagentModel: { provider: 'gp', model: 'gm' },
      sessions: { s1: { enabled: true, selected: ['general'] } },
    })
    const text = String(await toolOf(h.tools, 'agent_list').execute({}, exec))
    expect(text).toContain('全局子代理模型：gp / gm（未单独钉死模型的条目使用；条目级模型优先）')
    expect(text).toContain('模型：跟随全局子代理模型：gp / gm（未指定档位）')
    // 有全局设置时，未钉死条目不能再显示成「继承主会话」（会误导模型）
    expect(text).not.toContain('模型：继承主会话')
  })

  it('条目级钉死模型优先，清单同时说明全局默认', async () => {
    const entries = DEFAULT_SECTION.entries.map(entry =>
      entry.id === 'general' ? { ...entry, model: { provider: 'ep', model: 'em' } } : entry)
    const h = harness({
      subagentModel: { provider: 'gp', model: 'gm' },
      entries,
      sessions: { s1: { enabled: true, selected: ['general'] } },
    })
    const text = String(await toolOf(h.tools, 'agent_list').execute({}, exec))
    const generalLine = text.split('\n').find(line => line.startsWith('- general｜')) ?? ''
    expect(generalLine).toContain('模型：ep / em（未指定档位）')
    expect(generalLine).not.toContain('跟随全局子代理模型')
    // 其它未钉死模型的条目仍应显示「跟随全局」，全局设置本身单列一行
    expect(text).toContain('模型：跟随全局子代理模型：gp / gm')
    expect(text).toContain('全局子代理模型：gp / gm')
  })

  it('没有全局模型时维持原有「继承主会话」文案', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: ['general'] } } })
    const text = String(await toolOf(h.tools, 'agent_list').execute({}, exec))
    expect(text).toContain('全局子代理模型：继承主会话')
    expect(text).toContain('模型：继承主会话')
  })
})
