/**
 * 选择解析、闸门匹配与提示段渲染的单元测试（纯函数层，是本插件的语义核心）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SECTION, SECTION_HEADER } from '../src/defaults.ts'
import { readSection } from '../src/normalize.ts'
import {
  ALWAYS_AVAILABLE,
  childReplyAllowed,
  createGateMatcher,
  effectiveSelection,
  renderSectionText,
  renderSubagentRoster,
  resolveActive,
  sanitizeVariables,
} from '../src/plan.ts'
import type { ObAgentEntry, ObAgentSection } from '../src/contract.ts'

/** 在出厂默认上做局部覆盖，得到一份完整设置段。 */
function sectionOf(raw: Record<string, unknown> = {}): ObAgentSection {
  return readSection({ ...DEFAULT_SECTION, ...raw })
}

describe('effectiveSelection', () => {
  it('无会话记录时回落到出厂默认（总开关关、按 defaultEnabled 勾选）', () => {
    const selection = effectiveSelection(sectionOf(), 's1')
    expect(selection.enabled).toBe(false)
    expect(selection.selected).toContain('general')
    expect(selection.selected).toContain('agents_control')
    expect(selection.selected).toContain('agent_authoring')
    expect(selection.selected).not.toContain('code_review')
  })

  it('有会话记录时以记录为准，并丢弃已不存在的条目 id', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: ['code_review', 'gone'] } } })
    const selection = effectiveSelection(section, 's1')
    expect(selection.enabled).toBe(true)
    expect(selection.selected).toEqual(['code_review'])
  })
})

describe('resolveActive', () => {
  it('总开关关闭时不装配任何条目', () => {
    expect(resolveActive(sectionOf(), 's1')).toEqual([])
  })

  it('总开关打开时按勾选装配，并为可继续对话自动放行续话工具', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: ['general'] } } })
    const active = resolveActive(section, 's1').map(item => item.entry.id)
    expect(active).toContain('general')
    // general 是可继续对话子代理 → 自动放行续话/中止条目
    expect(active).toContain('agents_control')
    expect(active).not.toContain('code_review')
  })

  it('关闭自动放行后不再追加续话工具', () => {
    const section = sectionOf({
      autoEnableControlWithContinuable: false,
      sessions: { s1: { enabled: true, selected: ['general'] } },
    })
    expect(resolveActive(section, 's1').map(item => item.entry.id)).toEqual(['general'])
  })

  it('闸门逃生舱关闭时不管理任何条目', () => {
    const section = sectionOf({
      gate: { ...DEFAULT_SECTION.gate, enabled: false },
      sessions: { s1: { enabled: true, selected: ['general'] } },
    })
    expect(resolveActive(section, 's1')).toEqual([])
  })

  it('未纳管条目不出现在目标集合里', () => {
    const entries = DEFAULT_SECTION.entries.map(entry => (entry.id === 'general' ? { ...entry, managed: false } : entry))
    const section = readSection({
      ...DEFAULT_SECTION,
      entries,
      autoEnableControlWithContinuable: false,
      sessions: { s1: { enabled: true, selected: ['general'] } },
    })
    expect(resolveActive(section, 's1')).toEqual([])
  })

  it('子代理条目的工具名按模式派生', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: ['code_review'] } } })
    const active = resolveActive(section, 's1')
    expect(active[0]?.toolNames).toEqual(['subagent_code_review_session'])
  })
})

describe('createGateMatcher', () => {
  const matcher = createGateMatcher(sectionOf())

  it('按前缀拦下全部委派工具（含未列名的预设子代理）', () => {
    expect(matcher.denies('subagent')).toBe(true)
    expect(matcher.denies('subagent_hy4')).toBe(true)
    expect(matcher.denies('subagent_code_review_session_session')).toBe(true)
  })

  it('按精确名拦下续话与编排工具', () => {
    for (const name of ['send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph', 'agent_create']) {
      expect(matcher.denies(name)).toBe(true)
    }
  })

  it('不干涉普通工具', () => {
    expect(matcher.denies('read')).toBe(false)
    expect(matcher.denies('pwsh')).toBe(false)
    expect(matcher.denies('present')).toBe(false)
  })

  it('豁免名单优先于前缀与精确名', () => {
    const allowed = createGateMatcher(sectionOf({ gate: { ...DEFAULT_SECTION.gate, allow: ['ralph'] } }))
    expect(allowed.denies('ralph')).toBe(false)
    expect(allowed.denies('workflow')).toBe(true)
  })

  it('未纳管条目的工具名自动豁免（不纳管即不拦截）', () => {
    const entries = DEFAULT_SECTION.entries.map(entry => (entry.id === 'workflow' ? { ...entry, managed: false } : entry))
    const relaxed = createGateMatcher(readSection({ ...DEFAULT_SECTION, entries }))
    expect(relaxed.denies('workflow')).toBe(false)
  })

  it('非法前缀正则不影响其它规则', () => {
    const broken = createGateMatcher(sectionOf({ gate: { ...DEFAULT_SECTION.gate, prefixes: ['(['] } }))
    expect(broken.denies('subagent_hy4')).toBe(false)
    expect(broken.denies('workflow')).toBe(true)
  })
})

describe('sanitizeVariables', () => {
  it('保留允许的变量、转义未知变量（避免渲染期抛错打断请求）', () => {
    expect(sanitizeVariables('在 {{cwd}} 下，{{nope}} 未知', ['cwd'])).toBe('在 {{cwd}} 下，{ {nope}} 未知')
  })
  it('转义三重花括号（渲染器的解析方式与「合法引用正则」不同）', () => {
    const result = sanitizeVariables('{{{cwd}}}', ['cwd'])
    expect(result).not.toContain('{{{')
    expect(result).toBe('{ {{cwd}}}')
  })

  it('转义含非法字符的名字', () => {
    const result = sanitizeVariables('{{cwd-extra}}', ['cwd'])
    expect(result).toBe('{ {cwd-extra}}')
  })

  it('带空格的引用也要转义（运行时的变量名校验不接受空格，会直接抛错）', () => {
    expect(sanitizeVariables('{{ cwd }}', ['cwd'])).toBe('{ { cwd }}')
  })

  it('大写开头与非法字符的引用转义（运行时变量名必须小写开头）', () => {
    expect(sanitizeVariables('{{Cwd}}', ['Cwd', 'cwd'])).toBe('{ {Cwd}}')
    expect(sanitizeVariables('{{cwd_x}}', ['cwd_x'])).toBe('{{cwd_x}}')
  })

  it('没有配对的 {{ 也被转义', () => {
    expect(sanitizeVariables('只有 {{ 半边', ['cwd'])).toBe('只有 { { 半边')
  })

  it('正文完全不含引用时原样返回', () => {
    expect(sanitizeVariables('普通文本 {a} 与 } 号', ['cwd'])).toBe('普通文本 {a} 与 } 号')
  })
})

describe('renderSectionText', () => {
  it('闸门关闭时返回空串（空段会被丢弃）', () => {
    const section = sectionOf({ gate: { ...DEFAULT_SECTION.gate, enabled: false } })
    expect(renderSectionText(section, 's1', 'doc')).toBe('')
  })

  it('总开关关闭时说明「尚未启用任何 Agent 工具」', () => {
    const text = renderSectionText(sectionOf(), 's1', 'doc')
    expect(text).toContain('禁止调用')
    expect(text).toContain('总开关已关闭')
    expect(text).toContain('历史对话')
    expect(text).not.toContain('并行：')
  })

  it('勾选后列出工具名、权限与调用时机，并附并行约定', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: ['code_review'] } } })
    const text = renderSectionText(section, 's1', 'doc-path')
    expect(text).toContain('`subagent_code_review_session`')
    expect(text).toContain('代码审查')
    expect(text).toContain('可继续对话')
    expect(text).toContain('完全权限')
    expect(text).toContain('并行：')
    expect(text).not.toContain('agent_create')
  })

  it('勾选自助管理时给出文档位置与「下一轮可用」提示', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: ['agent_authoring'] } } })
    const text = renderSectionText(section, 's1', 'D:/x/docs/model-guide.md')
    expect(text).toContain('agent_create')
    expect(text).toContain('D:/x/docs/model-guide.md')
    expect(text).toContain('下一轮请求')
  })
})

describe('renderSubagentRoster（回答「有几个子代理」的能力清单）', () => {
  it('闸门未纳管（逃生舱）时说明「全部原生工具可用」，不能说成没有子代理', () => {
    const section = sectionOf({ gate: { ...DEFAULT_SECTION.gate, enabled: false } })
    const text = renderSubagentRoster(section, 's1')
    expect(text).toContain('0 个')
    expect(text).toContain('未纳管 Agent 工具')
    expect(text).toContain('全部可直接使用')
    expect(text).not.toContain('总开关')
  })

  it('总开关开启但未勾选任何条目时给出对应说明', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: [] } } })
    const text = renderSubagentRoster(section, 's1')
    expect(text).toContain('0 个')
    expect(text).toContain('没有勾选任何子代理条目')
  })

  it('本会话总开关关闭时不能谎称「总开关已开启」（三态必须区分）', () => {
    const section = sectionOf({ sessions: { s1: { enabled: false, selected: ['code_review'] } } })
    const text = renderSubagentRoster(section, 's1')
    expect(text).toContain('0 个')
    expect(text).toContain('总开关是关闭状态')
    expect(text).not.toContain('总开关已开启')
    // 与「已开启但未勾选」的输出必须不同，否则模型无法区分这两种相反状态
    const unselected = renderSubagentRoster(sectionOf({ sessions: { s1: { enabled: true, selected: [] } } }), 's1')
    expect(text).not.toBe(unselected)
  })

  it('旧双模式条目迁移为单个可继续对话工具', () => {
    // 出厂条目都是单模式，这里自建一条双模式条目（一次派生两个工具名）。
    const dual = {
      id: 'dual',
      kind: 'subagent',
      source: 'user',
      managed: true,
      defaultEnabled: false,
      name: '双模式',
      description: '',
      whenPrompt: 'x',
      identityPrompt: 'y',
      modes: ['one-shot', 'continuable'],
      provider: 'spawn',
      permission: 'full',
    }
    const section = sectionOf({
      entries: [...DEFAULT_SECTION.entries, dual],
      sessions: { s1: { enabled: true, selected: ['dual'] } },
    })
    const text = renderSubagentRoster(section, 's1')
    expect(text).not.toContain('`subagent_dual`')
    expect(text).toContain('`subagent_dual_session`')
    expect(text).toContain('1 个')
  })

  it('勾选后列出工具名、模式、权限与模型，且不混入未勾选条目', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: ['code_review'] } } })
    const text = renderSubagentRoster(section, 's1')
    expect(text).toContain('1 个')
    expect(text).toContain('`subagent_code_review_session`')
    expect(text).toContain('代码审查')
    expect(text).toContain('可继续对话')
    expect(text).toContain('完全权限')
    expect(text).toContain('全新上下文')
    expect(text).not.toContain('通用子代理')
    // 实例清单的引导行必须存在：能力清单是给「实例为空」补语义的
    expect(text).toContain('以下是子代理实例清单')
  })

  it('勾选原生条目时另列原生工具名（它们不是子代理，单独一行）', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: ['workflow'] } } })
    const text = renderSubagentRoster(section, 's1')
    expect(text).toContain('本会话另已放行的原生 Agent 工具')
    expect(text).toContain('`workflow`')
    expect(text).toContain('0 个')
  })

  it('清单随勾选实时变化（同一设置段对象、不同会话各算各的）', () => {
    const section = sectionOf({
      sessions: {
        s1: { enabled: true, selected: ['code_review'] },
        s2: { enabled: true, selected: ['general'] },
      },
    })
    expect(renderSubagentRoster(section, 's1')).toContain('`subagent_code_review_session`')
    expect(renderSubagentRoster(section, 's1')).not.toContain('`subagent_general_session`')
    expect(renderSubagentRoster(section, 's2')).toContain('`subagent_general_session`')
  })
})

describe('childReplyAllowed', () => {
  it('默认放行可继续对话的子代理，也放行模式读不到的子代理', () => {
    expect(childReplyAllowed(sectionOf(), 'continuable')).toBe(true)
    // unknown 必须放行：判定失败不能变成「子代理失去唯一的回发通道」
    expect(childReplyAllowed(sectionOf(), 'unknown')).toBe(true)
  })

  it('一次性子代理不放行（回发必然被相邻关系拒绝）', () => {
    expect(childReplyAllowed(sectionOf(), 'one-shot')).toBe(false)
  })

  it('开关关闭后一律不放行', () => {
    const off = sectionOf({ childReplyToParent: false })
    expect(childReplyAllowed(off, 'continuable')).toBe(false)
    expect(childReplyAllowed(off, 'unknown')).toBe(false)
  })
})

describe('renderSectionText：子代理作用域', () => {
  it('放行回发时只说明回发通道与目标父代理，不照抄主会话的能力清单', () => {
    const text = renderSectionText(sectionOf(), 'child-1', '', { parentSession: 'parent-9', reply: true })
    expect(text).toContain('send_message')
    expect(text).toContain('parent-9')
    // 子代理拿不到委派/续话/编排工具，列出主会话清单只会让它以为自己能委派
    expect(text).not.toContain(SECTION_HEADER)
    expect(text).not.toContain('subagent_general_session')
  })

  it('未放行时不注入任何 Agent 提示段（空段会被宿主丢弃）', () => {
    expect(renderSectionText(sectionOf(), 'child-1', '', { parentSession: 'parent-9', reply: false })).toBe('')
  })

  it('缺少父会话 id 时给出可读占位，而不是 undefined', () => {
    const text = renderSectionText(sectionOf(), 'child-1', '', { reply: true })
    expect(text).toContain('直接父代理的会话 id')
    expect(text).not.toContain('undefined')
  })

  it('父会话 id 含 `$` 序列时原样写入（替换不做展开）', () => {
    const text = renderSectionText(sectionOf(), 'child-1', '', { parentSession: 'p$&x', reply: true })
    expect(text).toContain('`p$&x`')
    expect(text).not.toContain('{parent}')
  })

  it('主会话调用（不传子代理入参）行为不变', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: ['general'] } } })
    const text = renderSectionText(section, 's1', 'docs/model-guide.md')
    expect(text).toContain(SECTION_HEADER)
    expect(text).toContain('`subagent_general_session`')
  })
})

describe('能力清单只列真的装上了的条目（可用性判定）', () => {
  /** 某会话勾选了这些条目。 */
  const selected = (ids: readonly string[]): ObAgentSection =>
    sectionOf({ sessions: { s1: { enabled: true, selected: [...ids] } } })

  it('声明了但本会话并不存在的原生工具，不能出现在提示段与清单里', () => {
    // 现场复现：`subagent_native` 声明 `subagent_hy4`，而当前预设根本没提供它 ——
    // 调用得到 `unknown tool`。协调器已判出档 C（并写日志），渲染层必须读这个结论，
    // 否则模型会照着清单去调用一个必然失败的名字。
    const section = selected(['general', 'subagent_native'])
    const available = (entry: ObAgentEntry): boolean => entry.id !== 'subagent_native'

    // 拿不到判定时（缺省）保持原行为 —— 只用于证明下面被摘掉的是判定起作用，不是本来就缺。
    expect(renderSubagentRoster(section, 's1')).toContain('`subagent_hy4`')
    expect(renderSectionText(section, 's1', 'd')).toContain('`subagent_hy4`')

    const roster = renderSubagentRoster(section, 's1', available)
    expect(roster).not.toContain('subagent_hy4')
    // 原生那一行只列真正可用的名字：`agents_control` 因「可继续对话」被自动放行，仍应出现。
    const nativeLine = roster.split('\n').find(line => line.includes('已放行的原生 Agent 工具')) ?? ''
    expect(nativeLine).toContain('`send_message`')
    expect(nativeLine).not.toContain('subagent_hy4')
    // 同会话真正可用的子代理条目不受牵连。
    expect(roster).toContain('`subagent_general_session`')

    const sectionText = renderSectionText(section, 's1', 'docs/model-guide.md', undefined, available)
    expect(sectionText).not.toContain('subagent_hy4')
    expect(sectionText).toContain('`subagent_general_session`')
  })

  it('缺省判定恒为可用（拿不到信息时宁可多报，也不藏起真实能力）', () => {
    const section = selected(['subagent_native'])
    expect(ALWAYS_AVAILABLE(DEFAULT_SECTION.entries[0] as ObAgentEntry)).toBe(true)
    expect(renderSubagentRoster(section, 's1')).toContain('subagent_hy4')
    expect(renderSubagentRoster(section, 's1', ALWAYS_AVAILABLE)).toContain('subagent_hy4')
  })

  it('只摘掉不可用的那一条，同会话其它原生条目照旧列出', () => {
    const section = selected(['workflow', 'ralph'])
    const text = renderSubagentRoster(section, 's1', entry => entry.id !== 'workflow')
    expect(text).toContain('`ralph`')
    expect(text).not.toContain('`workflow`')
  })
})

describe('全局子代理模型在系统提示与能力清单里生效', () => {
  const globalModel = { provider: 'gp', model: 'gm', reasoningEffort: 'low' }
  const globalSection = (raw: Record<string, unknown> = {}): ObAgentSection =>
    sectionOf({ subagentModel: globalModel, sessions: { s1: { enabled: true, selected: ['general'] } }, ...raw })

  it('未钉死模型的条目显示全局默认路由与档位', () => {
    const text = renderSectionText(globalSection(), 's1', 'doc')
    expect(text).toContain('模型：gp/gm（全局默认）')
    expect(text).toContain('思考档位：low')
  })

  it('能力清单同样展开全局默认，避免模型误以为继承了主会话', () => {
    const roster = renderSubagentRoster(globalSection(), 's1')
    expect(roster).toContain('模型：gp/gm（全局默认）')
  })

  it('条目钉死的模型优先，提示里不出现全局路由', () => {
    const entries = DEFAULT_SECTION.entries.map(entry =>
      entry.id === 'general' ? { ...entry, model: { provider: 'ep', model: 'em' } } : entry)
    const section = globalSection({ entries })
    const text = renderSectionText(section, 's1', 'doc')
    expect(text).toContain('模型：ep/em')
    expect(text).not.toContain('gp/gm')
  })

  it('没有全局模型时保持「继承 DSH 主会话」的旧措辞', () => {
    const section = sectionOf({ sessions: { s1: { enabled: true, selected: ['general'] } } })
    expect(renderSectionText(section, 's1', 'doc')).toContain('模型：继承 DSH 主会话')
  })
})
