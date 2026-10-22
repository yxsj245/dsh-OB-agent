/**
 * 客户端界面（dock 面板 + 设置页）的决策逻辑回归测试。
 *
 * 为什么这样测：这两块界面只在真实浏览器里跑（要装插件、重启 DSH、点开面板才能回归），
 * 而它们最容易被写错、写错也不报错的恰恰是几个**布尔决策**：
 * 1. 折叠箭头与开合状态对应（收起=向上、展开=向下），按用户要求反转旧版方向。
 * 2. 「智能体团队模式」是全局让位开关：开启后条目区只读，但**面板仍要能展开、那一行开关
 *    仍要能操作**，否则打开团队模式后就再也关不掉。
 *
 * 因此把这几件事收敛成 `src/client/store.ts` 里的纯函数（界面直接调用它们，不在 JSX 里
 * 重复写条件），在本文件里逐个断言。**不引入 react-dom / jsdom / react-test-renderer**：
 * 本插件的生产依赖只有 react（界面由宿主渲染），为测试加渲染器属于不必要的依赖。
 * 真正的渲染与点击行为仍由浏览器实测（装包、刷新页面）兜底。
 *
 * `vi.mock` 置顶替身宿主控件包：`dock.tsx` 会经 `host-ui.tsx` 具名导入它的图标与控件，
 * 而真包（ESM，带 CSS 与 clsx 等运行时依赖）在本仓库的解析链上不可加载。替身只需让那些
 * 具名导入取到「可渲染的东西」，本文件与它们无关的用例不渲染组件。
 *
 * 另有一组「真实接线」回归（见 `设置页真实接线`）：`vi.mock('react')` 提供极小的 hooks
 * 实现（useState 返回初值、useEffect 记下来、useSyncExternalStore 同步取值），于是可以直接
 * 调用 `ObAgentSection(snapshotProps)` 拿到**真实的 React 元素树**——既不需要 react-dom /
 * jsdom，也不是对源码做文本正则的镜像断言，能真正覆盖「那个按钮的 disabled 接到哪个变量」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObAgentSection as ObAgentSectionValue } from '../src/contract.ts'
import type { ClientSettingsScope, ObservableLike } from '../src/context-types.ts'
import type { ObAgentSnapshot, ObAgentWire } from '../src/client/store.ts'

/** 宿主控件/图标的替身：本文件只读导出与纯函数，不需要真实渲染。 */
function stub(name: string): () => null {
  const component = (): null => null
  Object.defineProperty(component, 'name', { value: name })
  return component
}

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: stub('Button'),
  DisclosureRow: stub('DisclosureRow'),
  Menu: stub('Menu'),
  Switch: stub('Switch'),
  Tag: stub('Tag'),
  Tooltip: stub('Tooltip'),
  IconAgentPresetOutlineRegular: stub('IconAgentPresetOutlineRegular'),
  IconChevronDownOutlineRegular: stub('IconChevronDownOutlineRegular'),
  IconChevronUpOutlineRegular: stub('IconChevronUpOutlineRegular'),
  IconCopyOutlineRegular: stub('IconCopyOutlineRegular'),
  IconPlusOutlineRegular: stub('IconPlusOutlineRegular'),
  IconSettingsOutlineRegular: stub('IconSettingsOutlineRegular'),
  IconTrashOutlineRegular: stub('IconTrashOutlineRegular'),
  // 旧命名（0.1.5 时代）：真实宿主上不存在，必须显式给 undefined，否则具名导入会报错。
  IconAgentPresetOutline16: undefined,
  IconChevronDownOutline14: undefined,
  IconChevronUpOutline14: undefined,
  IconCopyOutline16: undefined,
  IconPlusOutline16: undefined,
  IconSettingsOutline14: undefined,
  IconTrashOutline16: undefined,
}))

/**
 * `react` 的极小替身：只实现组件真正用到的那几个 hooks。
 *
 * 目的：能在**没有 react-dom / jsdom** 的情况下直接调用 `ObAgentSection(props)` 拿到真实的
 * 元素树（hooks 只被调用一次、不重渲染），于是可以断言「某个 Button 收到的 disabled 是多少」
 * 以及「点它的 onClick 会写什么」——这正是此前错过的那类接线 bug。
 *
 * 行为：useState 返回初值（setter 为空实现）、useEffect 把回调记下来、useSyncExternalStore
 * 同步取快照。importOriginal 保留 React 其余导出（createElement 等），让 stub 组件照样能建元素。
 */
const reactMockBindings = { effects: [] as (() => void)[] }

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: <S,>(initial: S | (() => S)): [S, (next: S) => void] => [
    typeof initial === 'function' ? (initial as () => S)() : initial,
    () => undefined,
  ],
  useEffect: (effect: () => void): void => { reactMockBindings.effects.push(effect) },
  useSyncExternalStore: <S,>(
    _subscribe: (listener: () => void) => () => void,
    getSnapshot: () => S,
  ): S => getSnapshot(),
}))

beforeEach(() => {
  reactMockBindings.effects = []
})

const { DEFAULT_SECTION } = await import('../src/defaults.ts')
const { dockLocked, dockSummaryKey, isDockExpandable, settingsLocked } = await import('../src/client/store.ts')
const { OB_AGENT_CSS } = await import('../src/client/styles.ts')
const { chevronIcon } = await import('../src/client/dock.tsx')
const { en, zh } = await import('../src/client/locales.ts')

describe('折叠箭头方向', () => {
  it('收起=向上箭头、展开=向下箭头', async () => {
    // chevronIcon 返回的是 host-ui 解析出来的图标组件（真实产物就是宿主图标），
    // 因此调用它再取内层元素类型——这一步同时覆盖 host-ui 的图标解析路径。
    const innerTypeName = (open: boolean): string => {
      const resolved = chevronIcon(open) as { type: (props: Record<string, unknown>) => unknown }
      const element = resolved.type({}) as { type?: { displayName?: string; name?: string } } | null
      const type = element?.type
      return type?.displayName ?? type?.name ?? ''
    }
    expect(innerTypeName(false)).toContain('IconChevronUp')
    expect(innerTypeName(true)).toContain('IconChevronDown')
  })

  it('样式表里不再有靠旋转表达展开的规则（方向由图标显式选择）', async () => {
    // 注释里允许提到这个已删除的类名（用来解释为什么不那么做），但选择器必须真的没了。
    expect(OB_AGENT_CSS).not.toContain('.dsh_obAgent_chevronOpen')
    expect(OB_AGENT_CSS).not.toContain('transform: rotate')
  })
})

describe('dock 面板的决策逻辑', () => {
  it('团队模式：总开关按「未接管」呈现——条目区整体视为已锁', () => {
    expect(dockLocked({ writable: true, pending: false, teamMode: true })).toBe(true)
    expect(dockLocked({ writable: true, pending: false, teamMode: false })).toBe(false)
    expect(dockLocked({ writable: false, pending: false, teamMode: false })).toBe(true)
    expect(dockLocked({ writable: true, pending: true, teamMode: false })).toBe(true)
  })

  it('团队模式：面板必须仍可展开（团队模式下会话总开关本来就是关的）', () => {
    // 会话开启：可展开。
    expect(isDockExpandable({ enabled: true, teamMode: false })).toBe(true)
    // 团队模式 + 会话关闭：仍然可展开，展开里那一行就是退出团队模式的入口。
    expect(isDockExpandable({ enabled: false, teamMode: true })).toBe(true)
    // 两者都不满足：不可展开（也不显示箭头）。
    expect(isDockExpandable({ enabled: false, teamMode: false })).toBe(false)
  })

  it('首行摘要按优先级取文案：写入中 > 团队模式 > 只读 > 未开启 > 未勾选 > 计数', () => {
    const cases = [
      [{ pending: true, teamMode: true, writable: false, enabled: false, count: 0 }, 'dock.pending'],
      [{ pending: false, teamMode: true, writable: false, enabled: true, count: 3 }, 'dock.teamLocked'],
      [{ pending: false, teamMode: false, writable: false, enabled: true, count: 3 }, 'dock.readonly'],
      [{ pending: false, teamMode: false, writable: true, enabled: false, count: 3 }, 'dock.blocked'],
      [{ pending: false, teamMode: false, writable: true, enabled: true, count: 0 }, 'dock.none'],
      [{ pending: false, teamMode: false, writable: true, enabled: true, count: 2 }, 'dock.count'],
    ] as const
    for (const [state, key] of cases) {
      expect(dockSummaryKey(state), `${key} 的优先级不对`).toBe(key)
    }
  })
})

describe('设置页的决策逻辑', () => {
  it('团队模式开启：其它字段只读，只有团队模式开关本身保持可操作', () => {
    const locked = settingsLocked({ writable: true, saving: false, teamMode: true })
    expect(locked.others).toBe(true)
    expect(locked.teamModeSwitch).toBe(false)
  })

  it('团队模式关闭：其它字段按「保存中 / 只读」判定，团队模式开关同样只受这两者影响', () => {
    const normal = settingsLocked({ writable: true, saving: false, teamMode: false })
    expect(normal.others).toBe(false)
    expect(normal.teamModeSwitch).toBe(false)
    for (const state of [{ writable: false, saving: false }, { writable: true, saving: true }]) {
      const locked = settingsLocked({ ...state, teamMode: false })
      expect(locked.others).toBe(true)
      expect(locked.teamModeSwitch).toBe(true)
    }
  })
})

describe('团队模式的文案与默认值', () => {
  const keys = ['dock.teamLocked', 'dock.teamLockedHint', 'dock.teamMode', 'dock.teamKicker',
    'dock.teamToggleLean', 'settings.teamMode', 'settings.teamModeDesc', 'settings.teamModeLocked',
    'settings.teamModeLockedNotice'] as const

  it('中英文键位齐全', () => {
    for (const key of keys) {
      expect(zh[key].trim(), `中文缺 ${key}`).not.toBe('')
      expect(en[key].trim(), `英文缺 ${key}`).not.toBe('')
    }
  })

  it('不承诺「自动启用官方插件」', () => {
    for (const key of keys) {
      for (const text of [zh[key], en[key]]) {
        // 只切换「是否接管」：不能写成会替用户开启官方团队。
        expect(text, `${key} 承诺了自动启用`).not.toMatch(/自动(启用|开启|安装)/)
        expect(text, `${key} 承诺了自动启用`).not.toMatch(/auto(matically)?[- ]?(enable|install)/i)
      }
    }
  })

  it('中文说明点明官方插件页与「官方团队还启用着就先停用」', () => {
    expect(zh['settings.teamModeDesc']).toContain('官方插件页')
    expect(zh['settings.teamModeDesc']).toContain('停用')
    expect(zh['dock.teamToggleLean']).toContain('官方插件页')
    expect(zh['dock.teamLockedHint']).toContain('官方插件页')
  })

  it('出厂默认关闭团队模式（默认接管行为不变）', () => {
    expect(DEFAULT_SECTION.teamMode).toBe(false)
  })
})

/** 假的作用域句柄：只需 getSnapshot / subscribe，写入路径不在本文件覆盖范围内。 */
function fakeScope(initial: ObAgentWire): ClientSettingsScope<ObAgentWire> {
  const listeners = new Set<() => void>()
  let value = initial
  return {
    getSnapshot: () => ({ status: 'ready', value, revision: 1, writable: true, mode: 'host' }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field, next) => { value = { ...value, [field]: next } },
    unset: async (field) => {
      const next = { ...value }
      delete next[field]
      value = next
    },
    mutate: async (ops) => {
      for (const op of ops) value = { ...value, [op.path[0] as string]: op.value }
    },
  }
}

/**
 * 造一个真实形状的界面快照（走真 store，字段与真接线一致）。
 * @param teamMode - 设置段里的团队模式取值。
 */
async function snapshotWith(teamMode: boolean): Promise<ObAgentSnapshot> {
  return snapshotWithRaw({ teamMode })
}

/** 同上，但允许直接给任意设置段字段（例如全局子代理模型）。 */
async function snapshotWithRaw(raw: ObAgentWire): Promise<ObAgentSnapshot> {
  const { createObAgentStore } = await import('../src/client/store.ts')
  return createObAgentStore(fakeScope(raw), 's1').getSnapshot()
}

// ── 真实接线回归（唯一审查发现的那个 bug 的守卫） ──────────────────────────────

/**
 * 遍历原始 React 元素对象，收集指定类型的元素（**不执行函数组件**）。
 *
 * `ObAgentSection` 的 footer 是它自己直接返回的 `<Button>`，所以只要走一遍 `props.children`
 * 就能拿到 Save 的真实入参——这正是「接线」本身：按审查发现的 bug，团队模式曾把这个按钮
 * 一起锁掉，于是打开团队模式后根本保存不了。
 * @param root - 组件返回的元素。
 * @param wanted - 目标类型（宿主替身函数）。
 * @returns 该类型元素的 props 列表。
 */
function collectByType(root: unknown, wanted: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const visit = (current: unknown): void => {
    const node = current as { type?: unknown; props?: Record<string, unknown> } | null
    if (node === null || typeof node !== 'object' || !('type' in node)) return
    if (node.type === wanted) out.push(node.props ?? {})
    const children = node.props?.children
    if (Array.isArray(children)) {
      for (const child of children) visit(child)
    } else if (children !== undefined && children !== null) {
      visit(children)
    }
  }
  visit(root)
  return out
}

describe('设置页真实接线：团队模式下打开 Save 仍可保存', () => {
  it('草稿 teamMode=true 时 Save 可用，点击后 patch 真的带上 teamMode:true', async () => {
    const { ObAgentSection } = await import('../src/client/section.tsx')
    const { Button } = await import('@deepseek-ai/dsh-client-ui-primitives')
    const snapshot = await snapshotWith(true)
    expect(snapshot.teamMode).toBe(true)
    const patched: Record<string, unknown>[] = []

    const element = ObAgentSection({
      hooks: { obAgent: {} as ObservableLike<ObAgentSnapshot> },
      patch: async (fields: Record<string, unknown>) => { patched.push(fields); return undefined },
      // 测试用：永不 resolve，免得 useEffect 里的 .then 落在用例之外（本用例不关心模型清单）。
      loadModels: () => new Promise<never>(() => undefined),
      useObAgent: selector => selector(snapshot),
      t: key => String(key),
    })
    // 让组件的 useEffect 真的跑一遍（界面行为的一部分）；它们不改本次断言依赖的状态。
    for (const effect of reactMockBindings.effects) effect()

    const save = collectByType(element, Button).find(props => props.children === 'settings.save')
    expect(save, '未找到保存按钮').toBeDefined()
    // 真 bug 就死在这里：团队模式曾把 footer 的 Save 一起锁掉，用户开了团队模式就再也保存不了。
    expect(save?.disabled, '团队模式下 Save 不应被锁').not.toBe(true)

    await (save?.onClick as () => Promise<void>)()
    await vi.waitFor(() => { expect(patched).toHaveLength(1) })
    expect(patched[0]?.teamMode).toBe(true)
    expect(patched[0]?.entries).toBeDefined()
  })
})

describe('设置页真实接线：全局子代理模型', () => {
  /** 渲染设置页并返回元素树；模型清单保持「加载中」，本组只断言接线本身。 */
  async function renderSection(raw: ObAgentWire): Promise<{ element: unknown; patched: Record<string, unknown>[] }> {
    const { ObAgentSection } = await import('../src/client/section.tsx')
    const snapshot = await snapshotWithRaw(raw)
    const patched: Record<string, unknown>[] = []
    const element = ObAgentSection({
      hooks: { obAgent: {} as ObservableLike<ObAgentSnapshot> },
      patch: async (fields: Record<string, unknown>) => { patched.push(fields); return undefined },
      loadModels: () => new Promise<never>(() => undefined),
      useObAgent: selector => selector(snapshot),
      t: key => String(key),
    })
    for (const effect of reactMockBindings.effects) effect()
    return { element, patched }
  }

  /** 点击设置页底部的保存按钮并等待一次写入。 */
  async function savePatched(element: unknown, patched: Record<string, unknown>[]): Promise<void> {
    const { Button } = await import('@deepseek-ai/dsh-client-ui-primitives')
    const save = collectByType(element, Button).find(props => props.children === 'settings.save')
    await (save?.onClick as () => Promise<void>)()
    await vi.waitFor(() => { expect(patched).toHaveLength(1) })
  }

  it('保存时写入 subagentModel：未设置写 null，已设置带回完整路由', async () => {
    const empty = await renderSection({ teamMode: false })
    await savePatched(empty.element, empty.patched)
    // 清除/未设置必须显式写 null，否则配置写入路径会丢掉这个字段
    expect(empty.patched[0]?.subagentModel).toBeNull()

    const globalModel = { provider: 'p', model: 'm', reasoningEffort: 'high' }
    const picked = await renderSection({ teamMode: false, subagentModel: globalModel })
    await savePatched(picked.element, picked.patched)
    expect(picked.patched[0]?.subagentModel).toEqual(globalModel)
  })

  it('全局模型下拉：未设置选中「继承主会话」，选择回传路由、清空回传 undefined', async () => {
    const { GlobalModelField } = await import('../src/client/section.tsx')
    const { Menu } = await import('@deepseek-ai/dsh-client-ui-primitives')
    const changes: unknown[] = []
    const element = GlobalModelField({
      model: undefined,
      catalog: undefined,
      disabled: false,
      t: key => String(key),
      open: false,
      onOpen: () => undefined,
      onChange: next => { changes.push(next) },
    })
    const menus = collectByType(element, Menu)
    expect(menus, '全局模型字段没有渲染下拉').toHaveLength(1)
    const items = menus[0]?.items as { label?: string }[]
    expect(items[0]?.label).toBe('settings.globalModelInherit')
    expect(menus[0]?.selectedId).toBe('')

    const onSelect = menus[0]?.onSelect as (id: string) => void
    onSelect('gp\u0000gm')
    onSelect('')
    expect(changes).toEqual([{ provider: 'gp', model: 'gm' }, undefined])
  })

  it('条目继承项在有全局模型时改为「跟随全局」，不再显示继承主会话', async () => {
    const { EntryCard } = await import('../src/client/section.tsx')
    const { Menu } = await import('@deepseek-ai/dsh-client-ui-primitives')
    const entry = {
      id: 'demo', kind: 'subagent', source: 'user', managed: true, defaultEnabled: false,
      name: '演示', description: '', whenPrompt: '需要时调用', identityPrompt: '你是演示子代理',
      modes: ['continuable'], provider: 'spawn', permission: 'full',
    } as const
    const element = EntryCard({
      entry: entry as never,
      index: 0,
      total: 1,
      t: key => String(key),
      catalog: undefined,
      globalModel: { provider: 'gp', model: 'gm' },
      globalReadOnly: [],
      disabled: false,
      onEdit: () => undefined,
      onRemove: () => undefined,
      onDuplicate: () => undefined,
      onMove: () => undefined,
      modelOpen: false,
      onModelOpen: () => undefined,
    })
    const menus = collectByType(element, Menu)
    const items = menus[0]?.items as { label?: string }[]
    expect(items[0]?.label).toBe('settings.entry.modelFollowGlobal')
  })
})
