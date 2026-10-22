/**
 * 插件自身的 live Config。新 DSH 通过 `configForms` 读取并写入易变配置；
 * 复杂字段的语义校验仍由 `normalize.ts` 完成。
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_SECTION } from './defaults.ts'

/** DSH 以易变引用传入 section，写入时由 profile Config Editor 校验并持久化。 */
export const Config = z.object({
  defaultsRevision: z.number().default(DEFAULT_SECTION.defaultsRevision).volatile(),
  masterEnabledDefault: z.boolean().default(DEFAULT_SECTION.masterEnabledDefault).volatile(),
  teamMode: z.boolean().default(DEFAULT_SECTION.teamMode).volatile(),
  dshHome: z.string().volatile(),
  readOnlyTools: z.array(z.string()).default(DEFAULT_SECTION.readOnlyTools).volatile(),
  promptVariables: z.array(z.string()).default(DEFAULT_SECTION.promptVariables).volatile(),
  autoEnableControlWithContinuable: z.boolean().default(DEFAULT_SECTION.autoEnableControlWithContinuable).volatile(),
  childReplyToParent: z.boolean().default(DEFAULT_SECTION.childReplyToParent).volatile(),
  gate: z.any().default(DEFAULT_SECTION.gate).volatile(),
  authoring: z.any().default(DEFAULT_SECTION.authoring).volatile(),
  modelGuide: z.any().default(DEFAULT_SECTION.modelGuide).volatile(),
  // 全局子代理模型：`null` / 缺省 = 继承主会话；写入形状为 { provider, model, reasoningEffort? }。
  subagentModel: z.any().default(null).volatile(),
  entries: z.any().default(DEFAULT_SECTION.entries).volatile(),
  sessions: z.any().default(DEFAULT_SECTION.sessions).volatile(),
})

export interface PluginConfig {
  defaultsRevision: { get(): unknown }
  masterEnabledDefault: { get(): unknown }
  teamMode: { get(): unknown }
  dshHome?: { get(): unknown }
  readOnlyTools: { get(): unknown }
  promptVariables: { get(): unknown }
  autoEnableControlWithContinuable: { get(): unknown }
  childReplyToParent: { get(): unknown }
  gate: { get(): unknown }
  authoring: { get(): unknown }
  modelGuide: { get(): unknown }
  subagentModel: { get(): unknown }
  entries: { get(): unknown }
  sessions: { get(): unknown }
}
