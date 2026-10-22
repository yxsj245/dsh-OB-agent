/**
 * 归一化与校验的单元测试：设置段的缺省补齐、非法条目的剔除、写入前的严格校验。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SECTION, DEFAULTS_REVISION } from '../src/defaults.ts'
import {
  collectVariables,
  migrateSection,
  normalizeEntry,
  readSection,
  readSessions,
  findMalformedReferences,
  validateEntry,
  validateSection,
} from '../src/normalize.ts'
import type { ObAgentEntry, ObAgentSection } from '../src/contract.ts'

const validEntry: ObAgentEntry = {
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
}

describe('readSection', () => {
  it('空输入回落为出厂默认', () => {
    const section = readSection(undefined)
    expect(section.masterEnabledDefault).toBe(false)
    expect(section.entries).toHaveLength(DEFAULT_SECTION.entries.length)
    expect(section.gate.prefixes).toContain('^subagent')
    expect(section.authoring.scope).toBe('own')
    expect(section.modelGuide.inject).toBe('path')
  })

  it('部分字段覆盖其余保持默认', () => {
    const section = readSection({ masterEnabledDefault: true, gate: { allow: ['ralph'] } })
    expect(section.masterEnabledDefault).toBe(true)
    expect(section.gate.allow).toEqual(['ralph'])
    expect(section.gate.tools).toEqual([...DEFAULT_SECTION.gate.tools])
  })

  it('子代理回发开关缺省时按出厂默认开启，显式关闭后保持关闭', () => {
    expect(readSection(undefined).childReplyToParent).toBe(true)
    expect(readSection({}).childReplyToParent).toBe(true)
    expect(readSection({ childReplyToParent: false }).childReplyToParent).toBe(false)
    // 非布尔值不能被当成 true：读不出来就回落默认
    expect(readSection({ childReplyToParent: 'yes' }).childReplyToParent).toBe(true)
  })

  it('entries 存在但非法时得到空表（不静默回退为出厂条目）', () => {
    expect(readSection({ entries: [{ id: 'BAD ID' }] }).entries).toEqual([])
  })

  it('未知的 impl 与非法模式被剔除', () => {
    const entry = normalizeEntry({ ...validEntry, impl: 'nope', modes: ['one-shot', 'weird'] })
    expect(entry?.impl).toBeUndefined()
    expect(entry?.modes).toEqual(['continuable'])
  })

  it('旧一次性和双模式条目只迁移模式，模型/身份/权限/勾选保持不变', () => {
    for (const modes of [['one-shot'], ['one-shot', 'continuable']]) {
      const raw = { ...validEntry, modes, model: { provider: 'custom', model: 'm' }, permission: 'readonly' }
      const section = readSection({ ...DEFAULT_SECTION, entries: [raw], sessions: { s1: { enabled: true, selected: ['demo'] } } })
      expect(section.entries[0]).toEqual({ ...raw, modes: ['continuable'] })
      expect(section.sessions.s1).toEqual({ enabled: true, selected: ['demo'] })
    }
  })

  it('来源缺省视为模型自建（写入方必须显式声明其它来源）', () => {
    const entry = normalizeEntry({ ...validEntry, source: undefined })
    expect(entry?.source).toBe('model')
  })
})

describe('readSessions', () => {
  it('丢弃形状不合法的会话记录', () => {
    const sessions = readSessions({ s1: { enabled: true, selected: ['a'] }, s2: { enabled: 'yes' }, s3: null })
    expect(Object.keys(sessions)).toEqual(['s1'])
  })

  it('非对象输入得到空映射', () => {
    expect(readSessions('nope')).toEqual({})
  })
})

describe('collectVariables', () => {
  it('只收集严格合法的引用（与运行时插值器一致）', () => {
    expect(collectVariables('{{cwd}} 与 {{cwd}}')).toEqual(['cwd'])
    // 带空格/大写的引用不是合法引用，不会被收集（由畸形引用校验负责报错）
    expect(collectVariables('{{ cwd }} {{Cwd}}')).toEqual([])
  })
})

describe('findMalformedReferences', () => {
  it('列出会让运行时插值器抛错的写法', () => {
    expect(findMalformedReferences('正常 {{cwd}}')).toEqual([])
    expect(findMalformedReferences('{{{cwd}}}')).toHaveLength(1)
    expect(findMalformedReferences('{{ cwd }}')).toHaveLength(1)
    expect(findMalformedReferences('{{Cwd}}')).toHaveLength(1)
    expect(findMalformedReferences('{{a-b}}')).toHaveLength(1)
    expect(findMalformedReferences('落单的 {{')).toHaveLength(1)
  })

  it('忽略普通花括号文本', () => {
    expect(findMalformedReferences('{a} 与 b}} 与 {')).toEqual([])
  })
})

describe('validateEntry', () => {
  const section = { promptVariables: ['cwd', 'model'], readOnlyTools: ['read'] }

  it('通过合法条目', () => {
    expect(validateEntry(validEntry, section, { takenIds: [] })).toEqual([])
  })

  it('拒绝非法标识与重名标识', () => {
    expect(validateEntry({ ...validEntry, id: 'Bad' }, section, { takenIds: [] })).toHaveLength(1)
    expect(validateEntry(validEntry, section, { takenIds: ['demo'] })[0]).toContain('已被占用')
  })

  it('拒绝空名称与空「何时调用」', () => {
    expect(validateEntry({ ...validEntry, name: '  ' }, section, { takenIds: [] })).toContain('名称不能为空')
    expect(validateEntry({ ...validEntry, whenPrompt: '' }, section, { takenIds: [] })).toContain('「何时调用」提示词不能为空')
  })

  it('子代理条目必须有运行模式与身份提示词', () => {
    const errors = validateEntry({ ...validEntry, modes: [], identityPrompt: '' }, section, { takenIds: [] })
    expect(errors).toContain('子代理条目至少要选择一种运行模式')
    expect(errors).toContain('子代理条目必须提供身份提示词')
  })

  it('只读权限需要非空白名单', () => {
    const errors = validateEntry({ ...validEntry, permission: 'readonly' }, { ...section, readOnlyTools: [] }, { takenIds: [] })
    expect(errors).toContain('只读权限需要非空的只读工具白名单')
  })

  it('未知提示词变量被拒绝（渲染期抛错会打断整个请求）', () => {
    const errors = validateEntry({ ...validEntry, whenPrompt: '见 {{secret}}' }, section, { takenIds: [] })
    expect(errors[0]).toContain('{{secret}}')
  })

  it('畸形引用被拒绝（运行时插值器只接受 {{小写名字}}）', () => {
    for (const text of ['{{{cwd}}}', '{{ cwd }}', '{{Cwd}}', '{{cwd-extra}}']) {
      const errors = validateEntry({ ...validEntry, whenPrompt: text }, section, { takenIds: [] })
      expect(errors.some(error => error.includes('无法解析的变量引用')), text).toBe(true)
    }
  })

  it('原生条目需要实现与工具名', () => {
    const errors = validateEntry({ ...validEntry, kind: 'native' }, section, { takenIds: [] })
    expect(errors).toContain('原生条目必须指定实现')
    expect(errors).toContain('原生条目必须给出工具名')
  })

  it('长度上限生效', () => {
    const errors = validateEntry({ ...validEntry, name: 'x'.repeat(200) }, section, { takenIds: [] })
    expect(errors.some(error => error.includes('名称过长'))).toBe(true)
  })
})

/** 模拟改写前落盘的旧设置段：旧内置条目（含已下线的 code_audit / fork）+ 一条用户自建 + 两条会话选择。 */
function legacySection(): ObAgentSection {
  const workflowEntry: ObAgentEntry = {
    id: 'workflow',
    kind: 'native',
    source: 'builtin',
    managed: false,
    defaultEnabled: false,
    name: '工作流编排',
    description: '',
    whenPrompt: '需要扇出时调用',
    modes: [],
    provider: 'spawn',
    permission: 'full',
    impl: 'workflow',
    toolNames: ['workflow'],
  }
  return {
    ...DEFAULT_SECTION,
    defaultsRevision: 0,
    entries: [
      { ...validEntry, id: 'code_review', source: 'builtin', name: '旧代码审查', whenPrompt: '旧提示词', identityPrompt: '旧身份' },
      { ...validEntry, id: 'code_audit', source: 'builtin', name: '代码审计（Hy4）', model: { provider: 'opencode-go', model: 'hy4-preview' } },
      { ...validEntry, id: 'fork', source: 'builtin', provider: 'fork' },
      { ...validEntry, id: 'mine', source: 'user', name: '我的条目' },
      workflowEntry,
    ],
    sessions: {
      s1: { enabled: true, selected: ['code_audit', 'gone'] },
      s2: { enabled: false, selected: ['mine'] },
    },
  }
}

describe('migrateSection', () => {
  it('版本已是最新时原样返回（幂等，不触发回写）', () => {
    const current = readSection(DEFAULT_SECTION)
    const result = migrateSection(current)
    expect(result.changed).toBe(false)
    expect(result.section).toBe(current)
  })

  it('旧内置条目被替换 / 下线 / 改名重定向，用户自建条目原样保留', () => {
    const result = migrateSection(legacySection())
    expect(result.changed).toBe(true)
    expect(result.section.defaultsRevision).toBe(DEFAULTS_REVISION)
    expect(result.section.entries.map(entry => entry.id)).toEqual(['code_review', 'mine', 'workflow'])
    // 原审查条目没有显式路由，迁移后仍继承 DSH；旧提示词按既有规则更新。
    expect(result.section.entries[0]?.model).toBeUndefined()
    expect(result.section.entries[0]?.whenPrompt).not.toBe('旧提示词')
    expect(result.section.entries[1]).toEqual(legacySection().entries[3])
  })

  it('第 2 版及以后内置审查提示词升级为文件改动触发版，自建条目和会话选择保持原样', () => {
    const previous = {
      ...DEFAULT_SECTION,
      defaultsRevision: 2,
      entries: DEFAULT_SECTION.entries.map(entry => entry.id === 'code_review'
        ? {
            ...entry,
            defaultEnabled: true,
            model: { provider: 'opencode-go', model: 'hy4-preview', reasoningEffort: 'high' },
            whenPrompt: '每完成一处代码改动就审查',
            identityPrompt: '旧身份提示词',
          }
        : entry),
      sessions: { s1: { enabled: true, selected: ['code_review'] } },
    }
    const result = migrateSection(previous)
    const review = result.section.entries.find(entry => entry.id === 'code_review')
    expect(result.changed).toBe(true)
    expect(review?.whenPrompt).toContain('每次实际修改文件后都立即调用代码审查（包括代码、配置和文档）')
    expect(review?.whenPrompt).toContain('本次审查已经提出的建议')
    expect(review?.identityPrompt).toContain('控制成本')
    expect(review?.defaultEnabled).toBe(true)
    expect(review?.model).toEqual({ provider: 'opencode-go', model: 'hy4-preview', reasoningEffort: 'high' })
    expect(result.section.sessions).toEqual(previous.sessions)
    expect(result.section.entries.find(entry => entry.id === 'general')).toEqual(DEFAULT_SECTION.entries.find(entry => entry.id === 'general'))
  })

  it('第 3 版审查提示词迁移时保留模型、权限和会话勾选', () => {
    const previous = {
      ...DEFAULT_SECTION,
      defaultsRevision: 3,
      entries: DEFAULT_SECTION.entries.map(entry => entry.id === 'code_review'
        ? {
            ...entry,
            whenPrompt: '旧的按需审查时机',
            identityPrompt: '旧身份',
            model: { provider: 'custom', model: 'reviewer', reasoningEffort: 'high' },
            defaultEnabled: true,
            managed: false,
            permission: 'readonly' as const,
          }
        : entry),
      sessions: { s1: { enabled: true, selected: ['code_review'] } },
    }
    const result = migrateSection(previous)
    const review = result.section.entries.find(entry => entry.id === 'code_review')
    expect(result.section.defaultsRevision).toBe(DEFAULTS_REVISION)
    expect(review?.whenPrompt).toContain('每次实际修改文件后都立即调用代码审查（包括代码、配置和文档）')
    expect(review?.identityPrompt).toContain('控制成本')
    expect(review?.model).toEqual({ provider: 'custom', model: 'reviewer', reasoningEffort: 'high' })
    expect(review?.defaultEnabled).toBe(true)
    expect(review?.managed).toBe(false)
    expect(review?.permission).toBe('readonly')
    expect(result.section.sessions).toEqual(previous.sessions)
  })

  it('保留用户手改过的「是否纳入管理」开关', () => {
    expect(migrateSection(legacySection()).section.entries[2]?.managed).toBe(false)
  })

  it('会话选择按改名重定向，并清掉指向已下线条目的 id', () => {
    const result = migrateSection(legacySection())
    expect(result.section.sessions['s1']).toEqual({ enabled: true, selected: ['code_review'] })
    expect(result.section.sessions['s2']).toEqual({ enabled: false, selected: ['mine'] })
  })

  it('真实入口 readSection：只有 sessions 的历史段迁移后仍保留改名后的勾选', () => {
    // 与用户实际落盘形状一致（ob-agent 段下只有 sessions，没有 entries / defaultsRevision）
    const section = readSection({ sessions: { s1: { enabled: true, selected: ['code_audit'] } } })
    expect(section.sessions['s1']).toEqual({ enabled: true, selected: ['code_review'] })
    expect(section.entries.map(entry => entry.id)).toContain('code_review')
    expect(section.defaultsRevision).toBe(DEFAULTS_REVISION)
  })

  it('设置段只有 sessions、没有 entries 时，改名标识的勾选仍被重定向', () => {
    // 真实场景：历史设置段里根本没有 entries 键，读出来的是新出厂表（其中已无 code_audit），
    // 因此改名映射绝不能依赖「表里是否存在旧标识」，否则该会话的勾选会被静默清空。
    const result = migrateSection({
      ...DEFAULT_SECTION,
      defaultsRevision: 0,
      entries: DEFAULT_SECTION.entries,
      sessions: { s1: { enabled: true, selected: ['code_audit'] } },
    })
    expect(result.section.sessions['s1']).toEqual({ enabled: true, selected: ['code_review'] })
  })

  it('表里只剩旧标识时，重定向会把新的出厂条目补进表里', () => {
    const onlyOld: ObAgentSection = {
      ...DEFAULT_SECTION,
      defaultsRevision: 0,
      entries: [{ ...validEntry, id: 'code_audit', source: 'builtin' }],
      sessions: { s1: { enabled: true, selected: ['code_audit'] } },
    }
    const result = migrateSection(onlyOld)
    expect(result.section.entries.map(entry => entry.id)).toEqual(['code_review'])
    expect(result.section.sessions['s1']?.selected).toEqual(['code_review'])
  })

  it('新旧标识同时在表里且旧标识在前时，不产生同 id 的重复条目', () => {
    const both: ObAgentSection = {
      ...DEFAULT_SECTION,
      defaultsRevision: 0,
      entries: [
        { ...validEntry, id: 'code_audit', source: 'builtin' },
        { ...validEntry, id: 'code_review', source: 'builtin' },
      ],
      sessions: { s1: { enabled: true, selected: ['code_audit'] } },
    }
    const result = migrateSection(both)
    expect(result.section.entries.map(entry => entry.id)).toEqual(['code_review'])
    expect(result.section.sessions['s1']?.selected).toEqual(['code_review'])
    expect(validateSection(result.section).some(error => error.includes('标识已被占用'))).toBe(false)
  })

  it('条目表为空时不会被悄悄复原成出厂条目', () => {
    const empty: ObAgentSection = { ...DEFAULT_SECTION, defaultsRevision: 0, entries: [] }
    expect(migrateSection(empty).section.entries).toEqual([])
  })
})

describe('validateSection', () => {
  it('出厂默认自身通过校验（内置条目与默认名单自洽）', () => {
    expect(validateSection(readSection(DEFAULT_SECTION))).toEqual([])
  })

  it('空条目表被拒绝', () => {
    expect(validateSection({ ...DEFAULT_SECTION, entries: [] })).toContain('至少要保留一条 Agent 条目')
  })

  it('条目上限小于条目数被拒绝', () => {
    const section = { ...DEFAULT_SECTION, authoring: { ...DEFAULT_SECTION.authoring, maxEntries: 1 } }
    expect(validateSection(section).some(error => error.includes('条目上限'))).toBe(true)
  })

  it('只读条目存在时全局白名单不能为空', () => {
    const entries = DEFAULT_SECTION.entries.map(entry => (entry.id === 'code_review' ? { ...entry, permission: 'readonly' as const } : entry))
    const section = { ...DEFAULT_SECTION, entries, readOnlyTools: [] }
    expect(validateSection(section)).toContain('存在只读条目时，只读工具白名单不能为空')
  })

  it('全局子代理模型半填（只给 provider 或只给 model）被拒绝', () => {
    expect(validateSection(readSection({ subagentModel: { provider: 'p', model: '' } })))
      .toContain('全局子代理模型需要同时给出 provider 与 model')
    expect(validateSection(readSection({ subagentModel: { provider: '', model: 'm' } })))
      .toContain('全局子代理模型需要同时给出 provider 与 model')
  })
})

describe('全局子代理模型', () => {
  it('缺省与 null 都表示继承主会话', () => {
    expect(readSection(undefined).subagentModel).toBeUndefined()
    expect(readSection({ subagentModel: null }).subagentModel).toBeUndefined()
    expect(DEFAULT_SECTION.subagentModel).toBeUndefined()
  })

  it('完整路由与可选思考档位被保留', () => {
    expect(readSection({ subagentModel: { provider: 'p', model: 'm' } }).subagentModel)
      .toEqual({ provider: 'p', model: 'm' })
    expect(readSection({ subagentModel: { provider: 'p', model: 'm', reasoningEffort: 'high' } }).subagentModel)
      .toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('形状不合法的值被丢弃（不能靠半个对象蒙混成固定路由）', () => {
    for (const raw of [{ provider: 'p' }, { model: 'm' }, 'p/m', 42, [], true]) {
      expect(readSection({ subagentModel: raw }).subagentModel).toBeUndefined()
    }
  })

  it('空串档位被当作未指定，不产生空字符串档位', () => {
    expect(readSection({ subagentModel: { provider: 'p', model: 'm', reasoningEffort: '' } }).subagentModel)
      .toEqual({ provider: 'p', model: 'm' })
  })

  it('迁移不改写已保存的全局模型（历史设置段照常读入）', () => {
    const section = readSection({ defaultsRevision: 0, subagentModel: { provider: 'p', model: 'm' } })
    expect(section.subagentModel).toEqual({ provider: 'p', model: 'm' })
    expect(section.defaultsRevision).toBe(DEFAULTS_REVISION)
  })
})
