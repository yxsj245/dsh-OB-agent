/**
 * 设置页「子代理」：全局开关、Agent 条目管理、模型自助管理开关与闸门名单。
 *
 * 视觉与栅格对齐 DSH 官方的「模型」设置页：720px 栏宽、12px 间距、0.5px 描边圆角卡片、
 * 胶囊按钮、官方 Tag / Switch / Menu / DisclosureRow。本文件只写布局类，控件外观全部
 * 来自 `@deepseek-ai/dsh-client-ui-primitives` 与设计令牌。
 *
 * 编辑策略：页面持有一份**草稿**（进入页面或保存后从快照重建），保存时一次性原子写入
 * 全部字段；校验在提交前本地跑一遍（与主机同一份 `validateSection`），失败不写。
 * 模型下拉读取宿主已配置的模型（`remote.session.modelCatalog()`），读取失败时降级为
 * 手动填写 provider / model，页面不整体不可用。
 */
import { useEffect, useState } from 'react'
import {
  Button,
  DisclosureRow,
  Menu,
  Switch,
  Tag,
  type MenuEntry,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ENTRY_LIMITS,
  subagentToolName,
  type ObAgentEntry,
  type ObAgentModel,
  type ObAgentSection as ObAgentSectionValue,
} from '../contract.ts'
import type { ObservableLike } from '../context-types.ts'
import { DEFAULT_SECTION } from '../defaults.ts'
import { validateSection } from '../normalize.ts'
import { IconChevronDown, IconChevronUp, IconCopy, IconPlus, IconSettings, IconTrash } from './host-ui.tsx'
import type { ObAgentKey } from './locales.ts'
import type { ModelCatalogResult } from './modelcatalog.ts'
import { settingsLocked, type ObAgentSnapshot } from './store.ts'

/** 注入面：设置快照、原子写入、模型清单读取。 */
export interface ObAgentSectionInjected {
  readonly hooks: { readonly obAgent: ObservableLike<ObAgentSnapshot> }
  readonly patch: (fields: Record<string, unknown>) => Promise<string | undefined>
  readonly loadModels: () => Promise<ModelCatalogResult>
}

/** 组件完整 props。 */
export interface ObAgentSectionProps extends ObAgentSectionInjected {
  readonly useObAgent: <S>(selector: (snapshot: ObAgentSnapshot) => S) => S
  readonly t: (key: ObAgentKey, params?: Record<string, string>) => string
}

/** 字段外壳：标签 + 控件 + 说明。 */
function Field(props: {
  label: string
  desc?: string | undefined
  children: JSX.Element | null
}): JSX.Element {
  return (
    <div className="dsh_obAgent_field">
      <span className="dsh_obAgent_fieldLabel">{props.label}</span>
      {props.children}
      {props.desc === undefined ? null : <span className="dsh_obAgent_fieldDesc">{props.desc}</span>}
    </div>
  )
}

/** 开关行：左说明右开关（设置页里的布尔项统一形状）。 */
function SwitchRow(props: {
  label: string
  desc?: string | undefined
  checked: boolean
  disabled?: boolean | undefined
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <div className="dsh_obAgent_switchRow">
      <div className="dsh_obAgent_switchText">
        <span className="dsh_obAgent_fieldLabel">{props.label}</span>
        {props.desc === undefined ? null : <span className="dsh_obAgent_fieldDesc">{props.desc}</span>}
      </div>
      <Switch
        checked={props.checked}
        disabled={props.disabled ?? false}
        label={props.label}
        onChange={props.onChange}
      />
    </div>
  )
}

/**
 * 把逗号分隔文本归一化（去空白、去空项），只用于比较「外部值是否真的变了」。
 * @param text - 输入框里的原始文本或外部值。
 * @returns 归一化后的逗号分隔文本。
 */
function normalizeList(text: string): string {
  return text.split(',').map(part => part.trim()).filter(part => part !== '').join(',')
}

/** 逗号分隔的字符串列表输入（编辑期保留原始文本，避免把正在输入的逗号吃掉）。 */
function ListField(props: {
  label: string
  desc?: string | undefined
  initial: readonly string[]
  disabled?: boolean | undefined
  onChange: (next: string[]) => void
}): JSX.Element {
  const [text, setText] = useState(props.initial.join(', '))
  const external = props.initial.join(', ')
  // 外部值变化（恢复出厂、保存成功后回落、条目被替换）必须同步进来：否则界面留着旧文本，
  // 用户随后再输入一个字符就会把旧值写回草稿（看起来已重置、一编辑就污染）。
  // 比较用归一化形式，避免吃掉正在输入的逗号与空格。
  useEffect(() => {
    setText(current => (normalizeList(current) === normalizeList(external) ? current : external))
  }, [external])
  return (
    <Field label={props.label} desc={props.desc}>
      <input
        className="dsh_obAgent_input"
        type="text"
        value={text}
        disabled={props.disabled ?? false}
        onChange={(event) => {
          setText(event.target.value)
          props.onChange(event.target.value.split(',').map(part => part.trim()).filter(part => part !== ''))
        }}
      />
    </Field>
  )
}

/** 单行文本字段。 */
function TextField(props: {
  label: string
  desc?: string | undefined
  value: string
  placeholder?: string | undefined
  disabled?: boolean | undefined
  onChange: (next: string) => void
}): JSX.Element {
  return (
    <Field label={props.label} desc={props.desc}>
      <input
        className="dsh_obAgent_input"
        type="text"
        value={props.value}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled ?? false}
        onChange={(event) => { props.onChange(event.target.value) }}
      />
    </Field>
  )
}

/** 多行文本字段（两段提示词用它，行高与设置页正文一致）。 */
function TextArea(props: {
  label: string
  desc?: string | undefined
  value: string
  disabled?: boolean | undefined
  onChange: (next: string) => void
}): JSX.Element {
  return (
    <Field label={props.label} desc={props.desc}>
      <textarea
        className="dsh_obAgent_textarea"
        value={props.value}
        disabled={props.disabled ?? false}
        onChange={(event) => { props.onChange(event.target.value) }}
      />
    </Field>
  )
}

/** 下拉框（原生 select + 令牌描边与官方箭头，与「模型」设置页同款）。 */
function SelectField(props: {
  label: string
  desc?: string | undefined
  value: string
  disabled?: boolean | undefined
  options: readonly { value: string; label: string }[]
  onChange: (next: string) => void
}): JSX.Element {
  return (
    <Field label={props.label} desc={props.desc}>
      <select
        className="dsh_obAgent_select dsh_obAgent_selectBox"
        value={props.value}
        disabled={props.disabled ?? false}
        onChange={(event) => { props.onChange(event.target.value) }}
      >
        {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  )
}

/** 新增条目模板（`source: 'user'`，标识满足校验规则）。 */
function newEntry(t: ObAgentSectionProps['t']): ObAgentEntry {
  return {
    id: `agent_${Math.random().toString(36).slice(2, 6)}`,
    kind: 'subagent',
    source: 'user',
    managed: true,
    defaultEnabled: false,
    name: t('settings.entry.newName'),
    description: '',
    whenPrompt: t('settings.entry.newWhen'),
    identityPrompt: t('settings.entry.newIdentity'),
    modes: ['continuable'],
    provider: 'spawn',
    permission: 'full',
  }
}

/** 条目来源对应的标签色调。 */
function originTone(entry: ObAgentEntry): TagTone {
  if (entry.source === 'model') return 'info'
  return entry.source === 'builtin' ? 'outline' : 'neutral'
}

/** 模型选择项：provider 作为父项，模型作为子菜单。 */
function modelMenuItems(catalog: ModelCatalogResult | undefined, inheritLabel: string): MenuEntry[] {
  const items: MenuEntry[] = [{ id: '', label: inheritLabel }]
  for (const provider of catalog?.providers ?? []) {
    items.push({
      id: `provider:${provider.id}`,
      label: provider.name,
      submenu: provider.models.map(model => ({ id: `${provider.id}\u0000${model.id}`, label: model.name })),
    })
  }
  return items
}

/**
 * 模型路由的展示名（`provider 名 / model 名`）。
 *
 * 清单里查不到时退回原始 id：用户手填的路由（清单读取失败时的降级通道）也必须能显示。
 * @param model - 待展示的路由。
 * @param catalog - 当前模型清单（可能尚未加载）。
 * @returns 可直接放进按钮/文案的名称。
 */
function modelDisplayName(
  model: { readonly provider: string; readonly model: string },
  catalog: ModelCatalogResult | undefined,
): string {
  const provider = catalog?.providers.find(item => item.id === model.provider)
  const modelName = provider?.models.find(item => item.id === model.model)?.name
  return `${provider?.name ?? model.provider} / ${modelName ?? model.model}`
}

/** 某条路由可选的思考档位（清单没有登记时为空，不展示档位下拉）。 */
function effortsOf(
  model: { readonly provider: string; readonly model: string } | undefined,
  catalog: ModelCatalogResult | undefined,
): readonly string[] {
  if (model === undefined) return []
  return catalog?.providers.find(item => item.id === model.provider)
    ?.models.find(item => item.id === model.model)?.efforts ?? []
}

/**
 * 全局子代理模型选择器。
 *
 * 与条目级模型共用同一份 DSH 模型清单（`remote.session.modelCatalog()`），因此用户
 * 在 DSH 设置里增删模型后，这里与条目下拉会同步变化；清单读取失败时降级为手填
 * provider / model，页面不整体不可用。
 *
 * 导出仅供离线接线测试直接调用（生产渲染仍由设置页完成）。
 */
export function GlobalModelField(props: {
  model: ObAgentModel | undefined
  catalog: ModelCatalogResult | undefined
  disabled: boolean
  t: ObAgentSectionProps['t']
  /** 下拉是否展开：状态提升到设置页，避免每次重渲染丢失。 */
  open: boolean
  onOpen: (open: boolean) => void
  onChange: (next: ObAgentModel | undefined) => void
}): JSX.Element {
  const { model, catalog, t } = props
  const selectedId = model === undefined ? '' : `${model.provider}\u0000${model.model}`
  const label = model === undefined ? t('settings.globalModelInherit') : modelDisplayName(model, catalog)
  const efforts = effortsOf(model, catalog)

  /** 选中清单里的一项；`''` = 清除全局设置、恢复继承主会话。 */
  const setModel = (id: string): void => {
    if (id === '') {
      props.onChange(undefined)
      return
    }
    const [provider, modelId] = id.split('\u0000')
    if (provider === undefined || modelId === undefined || provider === '' || modelId === '') return
    props.onChange({ provider, model: modelId })
  }

  /** 清单读取失败时的手填通道：两端都填才生效，清空则恢复继承。 */
  const setModelParts = (provider: string, modelId: string): void => {
    const nextProvider = provider.trim()
    const nextModel = modelId.trim()
    if (nextProvider === '' && nextModel === '') {
      props.onChange(undefined)
      return
    }
    props.onChange({ provider: nextProvider, model: nextModel })
  }

  return (
    <>
      {catalog !== undefined && catalog.error !== undefined ? (
        <>
          <div className="dsh_obAgent_field">
            <span className="dsh_obAgent_fieldLabel">{t('settings.globalModel')}</span>
            <span className="dsh_obAgent_fieldDesc">{t('settings.models.failed')}</span>
          </div>
          <TextField
            label={t('settings.entry.modelProvider')}
            value={model?.provider ?? ''}
            disabled={props.disabled}
            onChange={next => { setModelParts(next, model?.model ?? '') }}
          />
          <TextField
            label={t('settings.entry.modelId')}
            value={model?.model ?? ''}
            disabled={props.disabled}
            onChange={next => { setModelParts(model?.provider ?? '', next) }}
          />
        </>
      ) : (
        <Field
          label={t('settings.globalModel')}
          desc={catalog === undefined ? t('settings.models.loading') : t('settings.globalModelDesc')}
        >
          <Menu
            open={props.open}
            portal
            side="bottom"
            align="start"
            anchor={(
              <Button
                size="sm"
                variant="outline"
                disabled={props.disabled}
                onClick={() => { props.onOpen(!props.open) }}
              >
                {label}
              </Button>
            )}
            items={modelMenuItems(catalog, t('settings.globalModelInherit'))}
            selectedId={selectedId}
            onSelect={(id) => { props.onOpen(false); setModel(id) }}
            onClose={() => { props.onOpen(false) }}
          />
        </Field>
      )}
      {model !== undefined && efforts.length > 0 ? (
        <SelectField
          label={t('settings.entry.modelEffort')}
          value={model.reasoningEffort ?? ''}
          disabled={props.disabled}
          options={[{ value: '', label: '—' }, ...efforts.map(effort => ({ value: effort, label: effort }))]}
          onChange={(effort) => {
            props.onChange({
              provider: model.provider,
              model: model.model,
              ...(effort === '' ? {} : { reasoningEffort: effort }),
            })
          }}
        />
      ) : null}
    </>
  )
}

/**
 * 一条条目的编辑卡片。
 *
 * 导出仅供离线接线测试直接调用（生产渲染仍由设置页与宿主完成）。
 */
export function EntryCard(props: {
  entry: ObAgentEntry
  index: number
  total: number
  t: ObAgentSectionProps['t']
  catalog: ModelCatalogResult | undefined
  /** 全局子代理模型：条目未钉死模型时跟随它（界面据此显示继承去向）。 */
  globalModel: ObAgentModel | undefined
  globalReadOnly: readonly string[]
  disabled: boolean
  onEdit: (next: ObAgentEntry) => void
  onRemove: () => void
  onDuplicate: () => void
  onMove: (delta: number) => void
  /** 模型下拉是否展开：状态提升到父级并按条目标识记录（本卡片用下标作 key）。 */
  modelOpen: boolean
  onModelOpen: (open: boolean) => void
}): JSX.Element {
  const { entry, t } = props
  const subagent = entry.kind === 'subagent'
  const toolNames = subagent
    ? entry.modes.map(mode => subagentToolName(entry.id, mode))
    : [...(entry.toolNames ?? [])]
  const origin = entry.source === 'model'
    ? t('settings.entry.origin.model')
    : entry.source === 'builtin' ? t('settings.entry.origin.builtin') : t('settings.entry.origin.user')
  const selectedModel = entry.model === undefined ? '' : `${entry.model.provider}\u0000${entry.model.model}`
  // 「未钉死模型」的去向取决于全局设置：有全局模型时跟随全局，否则继承主会话。
  const inheritLabel = props.globalModel === undefined
    ? t('settings.entry.modelInherit')
    : t('settings.entry.modelFollowGlobal', { route: modelDisplayName(props.globalModel, props.catalog) })
  const modelLabel = entry.model === undefined
    ? inheritLabel
    : modelDisplayName(entry.model, props.catalog)
  const efforts = effortsOf(entry.model, props.catalog)
  const inheritedHint = entry.model === undefined && props.globalModel !== undefined
    ? t('settings.entry.modelGlobalHint', { route: modelDisplayName(props.globalModel, props.catalog) })
    : undefined

  const dropModel = (): void => {
    const { model: _dropped, ...rest } = entry
    props.onEdit(rest)
  }

  /** 选中模型清单里的一项：id 形如 `provider\\u0000model`；父项（仅展开子菜单）不含分隔符。 */
  const setModel = (id: string): void => {
    if (id === '') {
      dropModel()
      return
    }
    const [provider, model] = id.split('\u0000')
    if (provider === undefined || model === undefined || provider === '' || model === '') return
    props.onEdit({ ...entry, model: { provider, model } })
  }

  /** 模型清单读取失败时的手填通道：两端都填才钉死，清空则回到「继承主会话」。 */
  const setModelParts = (provider: string, model: string): void => {
    const nextProvider = provider.trim()
    const nextModel = model.trim()
    if (nextProvider === '' && nextModel === '') {
      dropModel()
      return
    }
    props.onEdit({ ...entry, model: { provider: nextProvider, model: nextModel } })
  }

  return (
    <li className="dsh_obAgent_card">
      <div className="dsh_obAgent_cardHead">
        <span className="dsh_obAgent_cardIdentity">
          <span className="dsh_obAgent_cardName">{entry.name || entry.id}</span>
          {subagent ? <span className="dsh_obAgent_cardId">{entry.id}</span> : null}
          <Tag tone="outline">{subagent ? t('settings.entry.kindSubagent') : t('settings.entry.kindNative')}</Tag>
          <Tag tone={originTone(entry)}>{origin}</Tag>
          {entry.managed ? null : <Tag tone="warning">{t('settings.entry.unmanaged')}</Tag>}
        </span>
        <span className="dsh_obAgent_cardActions">
          <Button
            size="sm"
            variant="ghost"
            className="dsh_obAgent_iconBtn"
            icon={<IconChevronUp />}
            disabled={props.disabled || props.index === 0}
            title={t('settings.entry.up')}
            aria-label={t('settings.entry.up')}
            onClick={() => { props.onMove(-1) }}
          />
          <Button
            size="sm"
            variant="ghost"
            className="dsh_obAgent_iconBtn"
            icon={<IconChevronDown />}
            disabled={props.disabled || props.index === props.total - 1}
            title={t('settings.entry.down')}
            aria-label={t('settings.entry.down')}
            onClick={() => { props.onMove(1) }}
          />
          <Button
            size="sm"
            variant="outline"
            icon={<IconCopy />}
            disabled={props.disabled}
            onClick={props.onDuplicate}
          >
            {t('settings.entry.duplicate')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="dsh_obAgent_danger"
            icon={<IconTrash />}
            disabled={props.disabled}
            onClick={props.onRemove}
          >
            {t('settings.entry.remove')}
          </Button>
        </span>
      </div>

      <div className="dsh_obAgent_fields">
        {subagent ? (
          <TextField
            label={t('settings.entry.id')}
            desc={t('settings.entry.idDesc')}
            value={entry.id}
            disabled={props.disabled}
            onChange={id => { props.onEdit({ ...entry, id }) }}
          />
        ) : null}
        <TextField
          label={t('settings.entry.name')}
          value={entry.name}
          disabled={props.disabled}
          onChange={name => { props.onEdit({ ...entry, name }) }}
        />
        <TextField
          label={t('settings.entry.description')}
          value={entry.description}
          disabled={props.disabled}
          onChange={description => { props.onEdit({ ...entry, description }) }}
        />
      </div>

      {subagent ? null : <span className="dsh_obAgent_groupDesc">{t('settings.entry.nativeHint')}</span>}

      <TextArea
        label={t('settings.entry.whenPrompt')}
        desc={t('settings.entry.whenPromptDesc')}
        value={entry.whenPrompt}
        disabled={props.disabled}
        onChange={whenPrompt => { props.onEdit({ ...entry, whenPrompt }) }}
      />

      {subagent ? (
        <>
          <TextArea
            label={t('settings.entry.identityPrompt')}
            desc={t('settings.entry.identityPromptDesc')}
            value={entry.identityPrompt ?? ''}
            disabled={props.disabled}
            onChange={identityPrompt => { props.onEdit({ ...entry, identityPrompt }) }}
          />
          <div className="dsh_obAgent_fields">
            <Field label={t('settings.entry.modes')} desc={t('settings.entry.modesDesc')}>
              <Tag tone="info">{t('mode.continuable')}</Tag>
            </Field>
            <SelectField
              label={t('settings.entry.provider')}
              value={entry.provider}
              disabled={props.disabled}
              options={[
                { value: 'spawn', label: t('provider.spawn') },
                { value: 'fork', label: t('provider.fork') },
              ]}
              onChange={(value) => { props.onEdit({ ...entry, provider: value === 'fork' ? 'fork' : 'spawn' }) }}
            />
            <SelectField
              label={t('settings.entry.permission')}
              desc={t('settings.entry.permissionDesc')}
              value={entry.permission}
              disabled={props.disabled}
              options={[
                { value: 'full', label: t('permission.full') },
                { value: 'readonly', label: t('permission.readonly') },
              ]}
              onChange={(value) => {
                props.onEdit({ ...entry, permission: value === 'readonly' ? 'readonly' : 'full' })
              }}
            />
          </div>

          <div className="dsh_obAgent_fields">
            {props.catalog !== undefined && props.catalog.error !== undefined ? (
              // 清单读取失败：降级为手填 provider / model，模型仍可钉死（校验会拦住半填状态）。
              <>
                <div className="dsh_obAgent_field">
                  <span className="dsh_obAgent_fieldLabel">{t('settings.entry.model')}</span>
                  <span className="dsh_obAgent_fieldDesc">{t('settings.models.failed')}</span>
                </div>
                <TextField
                  label={t('settings.entry.modelProvider')}
                  value={entry.model?.provider ?? ''}
                  disabled={props.disabled}
                  onChange={(next) => { setModelParts(next, entry.model?.model ?? '') }}
                />
                <TextField
                  label={t('settings.entry.modelId')}
                  value={entry.model?.model ?? ''}
                  disabled={props.disabled}
                  onChange={(next) => { setModelParts(entry.model?.provider ?? '', next) }}
                />
              </>
            ) : (
              <Field label={t('settings.entry.model')} desc={modelHint(props.catalog, t) ?? inheritedHint}>
                <Menu
                  open={props.modelOpen}
                  portal
                  side="bottom"
                  align="start"
                  anchor={(
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={props.disabled}
                      onClick={() => { props.onModelOpen(!props.modelOpen) }}
                    >
                      {modelLabel}
                    </Button>
                  )}
                  items={modelMenuItems(props.catalog, inheritLabel)}
                  selectedId={selectedModel}
                  onSelect={(id) => { props.onModelOpen(false); setModel(id) }}
                  onClose={() => { props.onModelOpen(false) }}
                />
              </Field>
            )}
            {efforts.length > 0 ? (
              <SelectField
                label={t('settings.entry.modelEffort')}
                value={entry.model?.reasoningEffort ?? ''}
                disabled={props.disabled}
                options={[{ value: '', label: '—' }, ...efforts.map(effort => ({ value: effort, label: effort }))]}
                onChange={(effort) => {
                  if (entry.model === undefined) return
                  props.onEdit({
                    ...entry,
                    model: {
                      provider: entry.model.provider,
                      model: entry.model.model,
                      ...(effort === '' ? {} : { reasoningEffort: effort }),
                    },
                  })
                }}
              />
            ) : null}
          </div>

          {entry.permission === 'readonly' ? (
            // key 用条目标识：条目被重排/删除后，这个位置可能换成另一条条目，
            // 组件必须随之重挂，否则会残留上一条的文本，用户一输入就把错误的列表写回去。
            <ListField
              key={`${entry.id}-readonly`}
              label={t('settings.entry.readOnlyAllow')}
              desc={t('settings.entry.readOnlyAllowDesc')}
              initial={entry.readOnlyAllow ?? []}
              disabled={props.disabled}
              onChange={(next) => {
                props.onEdit(next.length === 0 ? { ...entry, readOnlyAllow: undefined } : { ...entry, readOnlyAllow: next })
              }}
            />
          ) : null}
        </>
      ) : null}

      <div className="dsh_obAgent_fields">
        <SwitchRow
          label={t('settings.entry.defaultEnabled')}
          checked={entry.defaultEnabled}
          disabled={props.disabled}
          onChange={defaultEnabled => { props.onEdit({ ...entry, defaultEnabled }) }}
        />
        <SwitchRow
          label={t('settings.entry.managed')}
          desc={t('settings.entry.managedDesc')}
          checked={entry.managed}
          disabled={props.disabled}
          onChange={managed => { props.onEdit({ ...entry, managed }) }}
        />
      </div>

      <span className="dsh_obAgent_code">
        {t('settings.entry.toolNames')}：{toolNames.join('  ') || '—'}
      </span>
      {subagent && entry.permission !== 'readonly' && entry.readOnlyAllow !== undefined ? (
        <span className="dsh_obAgent_groupDesc">
          {t('settings.entry.readOnlyDormant', {
            list: entry.readOnlyAllow.join('、'),
            global: props.globalReadOnly.join('、'),
          })}
        </span>
      ) : null}
    </li>
  )
}

/** 模型字段下方的提示：清单读取中 / 读取失败。 */
function modelHint(catalog: ModelCatalogResult | undefined, t: ObAgentSectionProps['t']): string | undefined {
  if (catalog === undefined) return t('settings.models.loading')
  if (catalog.error !== undefined) return t('settings.models.failed')
  return undefined
}

/**
 * 设置页主体。
 * @param props - 框架注入的 props。
 */
export function ObAgentSection(props: ObAgentSectionProps): JSX.Element {
  const { useObAgent, patch, loadModels, t } = props
  const snapshot = useObAgent(value => value)
  const [draft, setDraft] = useState<ObAgentSectionValue | undefined>(undefined)
  const [catalog, setCatalog] = useState<ModelCatalogResult | undefined>(undefined)
  const [gateOpen, setGateOpen] = useState(false)
  /** 当前展开模型下拉的条目标识：按标识记录，卡片重排/删除不会让菜单挂到别的条目上。 */
  const [modelMenuId, setModelMenuId] = useState<string | undefined>(undefined)
  /** 全局子代理模型下拉的展开状态（与条目下拉分开，两者互不干扰）。 */
  const [globalModelOpen, setGlobalModelOpen] = useState(false)
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ kind: 'idle' })
  const [errors, setErrors] = useState<readonly string[]>([])
  /** 「恢复出厂」的两步确认状态：第一次点击只进入待确认态。 */
  const [resetArmed, setResetArmed] = useState(false)

  useEffect(() => {
    let alive = true
    void loadModels().then((result) => { if (alive) setCatalog(result) })
    return () => { alive = false }
  }, [loadModels])

  const current = draft ?? snapshot.section
  const disabled = status.kind === 'saving' || !snapshot.writable
  /**
   * 团队模式：以草稿里的取值为准（切换后立刻反映到界面）。开启后本插件不接管代理：
   * 除「智能体团队模式」开关本身（用来关掉它）之外，全局开关、条目选择与自助管理都不再可操作。
   * 官方团队的实际启用状态由 DSH 官方管理，本插件既不读取也不代为开关。
   *
   * 两个锁由 store.settingsLocked 统一给出（离线测试覆盖）：
   * `lockedByTeam` 用于其它字段，`teamModeLocked` 只受「保存中 / 设置只读」影响。
   */
  const teamMode = current.teamMode
  const locks = settingsLocked({ writable: snapshot.writable, saving: status.kind === 'saving', teamMode })
  const lockedByTeam = locks.others
  const teamModeLocked = locks.teamModeSwitch
  const edit = (patchDraft: Partial<ObAgentSectionValue>): void => {
    setDraft({ ...current, ...patchDraft })
    setStatus({ kind: 'idle' })
    // 任何编辑都解除「恢复出厂」的待确认态：确认动作必须紧邻那次破坏性写入。
    setResetArmed(false)
  }
  const editEntries = (entries: readonly ObAgentEntry[]): void => {
    edit({ entries: [...entries] })
  }

  const save = async (): Promise<void> => {
    setResetArmed(false)
    const found = validateSection(current)
    setErrors(found)
    if (found.length > 0) {
      setStatus({ kind: 'error', message: t('settings.invalid') })
      return
    }
    setStatus({ kind: 'saving' })
    const failure = await patch({
      masterEnabledDefault: current.masterEnabledDefault,
      readOnlyTools: [...current.readOnlyTools],
      promptVariables: [...current.promptVariables],
      autoEnableControlWithContinuable: current.autoEnableControlWithContinuable,
      childReplyToParent: current.childReplyToParent,
      teamMode: current.teamMode,
      gate: { ...current.gate },
      authoring: { ...current.authoring },
      modelGuide: { ...current.modelGuide },
      // 清除全局模型必须写 null：config 的「未设置」与「继承主会话」是同一个状态，
      // 用可序列化的 null 表达，避免 undefined 在配置写入路径上被丢弃。
      subagentModel: current.subagentModel ?? null,
      entries: current.entries.map(entry => ({ ...entry })),
    })
    if (failure !== undefined) {
      setStatus({ kind: 'error', message: failure })
      return
    }
    setStatus({ kind: 'saved' })
    setErrors([])
    setDraft(undefined)
  }

  /**
   * 恢复出厂：把全部可编辑字段写回出厂值。
   *
   * 为什么必须真的写盘：迁移规则「设置段里没有的内置条目不补」，一旦条目被删空，
   * 界面上的「新增条目」只能建子代理条目，原生条目无法重建——只丢弃草稿的假恢复出厂
   * 会让内置条目永远回不来。这里**不写 `sessions`**：各会话已勾选项保留，指向已不存在
   * 条目的标识由 `effectiveSelection` 自动过滤。
   */
  const restoreFactory = async (): Promise<void> => {
    setResetArmed(false)
    setStatus({ kind: 'saving' })
    const failure = await patch({
      defaultsRevision: DEFAULT_SECTION.defaultsRevision,
      masterEnabledDefault: DEFAULT_SECTION.masterEnabledDefault,
      readOnlyTools: [...DEFAULT_SECTION.readOnlyTools],
      promptVariables: [...DEFAULT_SECTION.promptVariables],
      autoEnableControlWithContinuable: DEFAULT_SECTION.autoEnableControlWithContinuable,
      childReplyToParent: DEFAULT_SECTION.childReplyToParent,
      teamMode: DEFAULT_SECTION.teamMode,
      gate: { ...DEFAULT_SECTION.gate },
      authoring: { ...DEFAULT_SECTION.authoring },
      modelGuide: { ...DEFAULT_SECTION.modelGuide },
      // 出厂默认：不钉死全局模型，继承主会话。
      subagentModel: null,
      entries: DEFAULT_SECTION.entries.map(entry => ({ ...entry })),
    })
    if (failure !== undefined) {
      setStatus({ kind: 'error', message: failure })
      return
    }
    setStatus({ kind: 'saved' })
    setErrors([])
    setDraft(undefined)
  }

  if (snapshot.status === 'unavailable') {
    return (
      <section className="dsh_obAgent_section">
        <p className="dsh_obAgent_error" role="status">{t('settings.unavailable')}</p>
      </section>
    )
  }

  return (
    <section className="dsh_obAgent_section">
      <h2 className="dsh_obAgent_title">{t('settings.title')}</h2>
      <p className="dsh_obAgent_intro">{t('settings.subtitle')}</p>

      {teamMode ? (
        <span className="dsh_obAgent_teamHint" role="status">{t('settings.teamModeLockedNotice')}</span>
      ) : null}

      {status.kind === 'error' && status.message !== undefined ? (
        <p className="dsh_obAgent_error" role="status">{status.message}</p>
      ) : null}
      {status.kind === 'saved' ? (
        <p className="dsh_obAgent_savedNotice" role="status">{t('settings.saved')}</p>
      ) : null}
      {errors.length > 0 ? (
        <ul className="dsh_obAgent_errorList">
          {errors.slice(0, 12).map(error => <li key={error}>{error}</li>)}
        </ul>
      ) : null}

      <ul className="dsh_obAgent_rows">
        <li className="dsh_obAgent_card">
          <div className="dsh_obAgent_cardHead">
            <span className="dsh_obAgent_cardIdentity">
              <span className="dsh_obAgent_cardName">{t('settings.global')}</span>
            </span>
          </div>
          {/* 团队模式是「本插件是否接管代理」的总让位开关，因此排在全局卡片第一条。
              它自己永远可操作（否则打开后就再也关不掉）：只跟「保存中 / 设置只读」有关，
              不随团队模式锁定。安装与启用官方团队插件仍由用户在 DSH 官方插件页操作。 */}
          <SwitchRow
            label={t('settings.teamMode')}
            desc={t('settings.teamModeDesc')}
            checked={teamMode}
            disabled={teamModeLocked}
            onChange={(next) => { edit({ teamMode: next }) }}
          />
          <SwitchRow
            label={t('settings.masterDefault')}
            desc={t('settings.masterDefaultDesc')}
            checked={current.masterEnabledDefault}
            disabled={lockedByTeam}
            onChange={masterEnabledDefault => { edit({ masterEnabledDefault }) }}
          />
          <SwitchRow
            label={t('settings.autoControl')}
            desc={t('settings.autoControlDesc')}
            checked={current.autoEnableControlWithContinuable}
            disabled={lockedByTeam}
            onChange={autoEnableControlWithContinuable => { edit({ autoEnableControlWithContinuable }) }}
          />
          <SwitchRow
            label={t('settings.childReply')}
            desc={t('settings.childReplyDesc')}
            checked={current.childReplyToParent}
            disabled={lockedByTeam}
            onChange={childReplyToParent => { edit({ childReplyToParent }) }}
          />
          <div className="dsh_obAgent_fields">
            <GlobalModelField
              model={current.subagentModel}
              catalog={catalog}
              disabled={lockedByTeam}
              t={t}
              open={globalModelOpen}
              onOpen={setGlobalModelOpen}
              onChange={subagentModel => { edit({ subagentModel }) }}
            />
            <SelectField
              label={t('settings.guideInject')}
              desc={t('settings.guideInjectDesc')}
              value={current.modelGuide.inject}
              disabled={lockedByTeam}
              options={[
                { value: 'path', label: 'path' },
                { value: 'inline', label: 'inline' },
                { value: 'off', label: 'off' },
              ]}
              onChange={(value) => {
                const inject = value === 'inline' || value === 'off' ? value : 'path'
                edit({ modelGuide: { inject } })
              }}
            />
            <ListField
              label={t('settings.readOnlyTools')}
              desc={t('settings.readOnlyToolsDesc')}
              initial={current.readOnlyTools}
              disabled={lockedByTeam}
              onChange={readOnlyTools => { edit({ readOnlyTools }) }}
            />
            <ListField
              label={t('settings.promptVariables')}
              desc={t('settings.promptVariablesDesc')}
              initial={current.promptVariables}
              disabled={lockedByTeam}
              onChange={promptVariables => { edit({ promptVariables }) }}
            />
          </div>
        </li>

        <li className="dsh_obAgent_card">
          <div className="dsh_obAgent_cardHead">
            <span className="dsh_obAgent_cardIdentity">
              <span className="dsh_obAgent_cardName">{t('settings.entries')}</span>
              <Tag tone="outline">{`${current.entries.length} / ${current.authoring.maxEntries}`}</Tag>
            </span>
            <span className="dsh_obAgent_cardActions">
              <Button
                size="sm"
                variant="outline"
                icon={<IconPlus />}
                disabled={lockedByTeam || current.entries.length >= current.authoring.maxEntries}
                onClick={() => { editEntries([...current.entries, newEntry(t)]) }}
              >
                {t('settings.entry.add')}
              </Button>
            </span>
          </div>
          <span className="dsh_obAgent_groupDesc">{t('settings.entriesDesc')}</span>
          <ul className="dsh_obAgent_rows">
            {current.entries.map((entry, index) => (
              // key 用下标而不是 entry.id：标识本身是可编辑字段，用 id 作 key 会在每次
              // 输入标识时重挂卡片、夺走输入框焦点（只能一个字一个字地输入）。
              <EntryCard
                key={index}
                entry={entry}
                index={index}
                total={current.entries.length}
                t={t}
                catalog={catalog}
                globalModel={current.subagentModel}
                globalReadOnly={current.readOnlyTools}
                disabled={lockedByTeam}
                onEdit={(next) => {
                  editEntries(current.entries.map((item, i) => (i === index ? next : item)))
                }}
                onRemove={() => { editEntries(current.entries.filter((_item, i) => i !== index)) }}
                onDuplicate={() => {
                  const copy = {
                    ...entry,
                    id: `${entry.id}_copy`,
                    name: t('settings.entry.copyName', { name: entry.name }),
                    source: 'user' as const,
                  }
                  editEntries([...current.entries.slice(0, index + 1), copy, ...current.entries.slice(index + 1)])
                }}
                onMove={(delta) => {
                  const target = index + delta
                  if (target < 0 || target >= current.entries.length) return
                  const next = [...current.entries]
                  const [moved] = next.splice(index, 1)
                  if (moved === undefined) return
                  next.splice(target, 0, moved)
                  editEntries(next)
                }}
                modelOpen={modelMenuId === entry.id}
                onModelOpen={(open) => { setModelMenuId(open ? entry.id : undefined) }}
              />
            ))}
          </ul>
        </li>

        <li className="dsh_obAgent_card">
          <div className="dsh_obAgent_cardHead">
            <span className="dsh_obAgent_cardIdentity">
              <span className="dsh_obAgent_cardName">{t('settings.authoring')}</span>
            </span>
          </div>
          <SwitchRow
            label={t('settings.authoring.enabled')}
            desc={t('settings.authoring.enabledDesc')}
            checked={current.authoring.enabled}
            disabled={lockedByTeam}
            onChange={enabled => { edit({ authoring: { ...current.authoring, enabled } }) }}
          />
          <div className="dsh_obAgent_fields">
            <SelectField
              label={t('settings.authoring.scope')}
              value={current.authoring.scope}
              disabled={lockedByTeam}
              options={[
                { value: 'own', label: t('settings.authoring.scope.own') },
                { value: 'all', label: t('settings.authoring.scope.all') },
              ]}
              onChange={(value) => {
                edit({ authoring: { ...current.authoring, scope: value === 'all' ? 'all' : 'own' } })
              }}
            />
            <Field label={t('settings.authoring.maxEntries')}>
              <input
                className="dsh_obAgent_input"
                type="number"
                min={1}
                value={current.authoring.maxEntries}
                disabled={lockedByTeam}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10)
                  edit({ authoring: { ...current.authoring, maxEntries: Number.isFinite(value) ? Math.max(1, value) : 1 } })
                }}
              />
            </Field>
          </div>
        </li>

        <li className="dsh_obAgent_card">
          <DisclosureRow
            icon={<IconSettings />}
            title={t('settings.gate')}
            open={gateOpen}
            expandable
            expandOnRowClick
            onToggle={() => { setGateOpen(value => !value) }}
          >
            <div className="dsh_obAgent_editor">
              <SwitchRow
                label={t('settings.gate.enabled')}
                desc={t('settings.gate.enabledDesc')}
                checked={current.gate.enabled}
                disabled={lockedByTeam}
                onChange={enabled => { edit({ gate: { ...current.gate, enabled } }) }}
              />
              <div className="dsh_obAgent_fields">
                <ListField
                  label={t('settings.gate.prefixes')}
                  desc={t('settings.gate.prefixesDesc')}
                  initial={current.gate.prefixes}
                  disabled={lockedByTeam}
                  onChange={prefixes => { edit({ gate: { ...current.gate, prefixes } }) }}
                />
                <ListField
                  label={t('settings.gate.tools')}
                  desc={t('settings.gate.toolsDesc')}
                  initial={current.gate.tools}
                  disabled={lockedByTeam}
                  onChange={tools => { edit({ gate: { ...current.gate, tools } }) }}
                />
                <ListField
                  label={t('settings.gate.allow')}
                  desc={t('settings.gate.allowDesc')}
                  initial={current.gate.allow}
                  disabled={lockedByTeam}
                  onChange={allow => { edit({ gate: { ...current.gate, allow } }) }}
                />
              </div>
              <ListField
                label={t('settings.gate.reprovide')}
                desc={t('settings.gate.reprovideDesc')}
                initial={current.gate.reprovide}
                disabled={lockedByTeam}
                onChange={reprovide => { edit({ gate: { ...current.gate, reprovide } }) }}
              />
            </div>
          </DisclosureRow>
        </li>
      </ul>

      <div className="dsh_obAgent_footer">
        <Button
          variant="primary"
          disabled={disabled}
          onClick={() => { void save() }}
        >
          {status.kind === 'saving' ? t('settings.saving') : t('settings.save')}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || draft === undefined}
          onClick={() => { setDraft(undefined); setStatus({ kind: 'idle' }); setErrors([]); setResetArmed(false) }}
        >
          {t('settings.discard')}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            // 两步确认：破坏性写入不放在一次误点里。
            if (resetArmed) { void restoreFactory(); return }
            setResetArmed(true)
          }}
        >
          {resetArmed ? t('settings.resetArmed') : t('settings.reset')}
        </Button>
        {draft === undefined ? null : <span className="dsh_obAgent_hint">{t('settings.dirty')}</span>}
      </div>
    </section>
  )
}
