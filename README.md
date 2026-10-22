# dsh-ob-agent

DSH（DeepSeek Harness）的 Agent 能力统一控制插件。

- 一个聊天框总开关：关闭时隐藏继承的 Agent 工具，并在执行层拒绝残留工具。
- 全局子代理模型：一次选择所有子代理默认使用的模型（清单与 DSH 已配置的模型一致），条目级模型优先。
- 角色条目：调用时机、子代理身份、spawn/fork、模型、思考档位、只读/完全权限。
- 每会话勾选：选择按会话保存，系统提示只列当前实际可用的能力。
- 模型自助：`agent_create / agent_update / agent_list` 创建可复用角色，默认仅可改自建条目。
- 子代理可回发给直接父代理，但不能再次委派。

## 当前版本

**0.3.0，适配 DSH 0.2.1-rc.2。**

0.3.0 增加「全局子代理模型」：在设置页的全局卡片里直接选择所有子代理默认使用的
provider / model / 思考档位，模型清单读取 DSH 自己的模型设置（与条目级下拉同源）。
优先级为「条目钉死 > 全局设置 > 继承主会话」：已经固定模型的角色保持可复现，其余角色
一次切换。系统提示与 `agent_list` 会显示每条子代理实际使用的路由，避免模型误以为在继承
主会话；未设置时不改变既有行为（仍继承主会话）。详见 [0.3.0 升级说明](<docs/v0.3.0.md>)。

0.2.0 增加「智能体团队模式」：先释放本插件的角色工具、限制和能力提示，再由用户在 DSH 插件页开启官方智能体团队。官方团队服务已存在时自动避让；本插件不安装或实现团队工具。关闭普通子代理总开关时，系统提示会明确禁止沿用历史工具名。部分更新保留未提交字段，委派深度继承宿主，面板展开/收起箭头已修正。完整操作与边界见 [0.2.0 升级说明](<docs/v0.2.0.md>)。

新版宿主拒绝子代理工具配置中的 `persona / toolFilter`，且 `apply()` 已改为异步。
本版使用公开 activation API 与串行生命周期钩子保留条目身份和权限；所有拒绝均被等待和处理，
不再让异步装配失败逃逸成宿主 `fatal load failure`。

**一次性模式已按用户要求移除。** 新建子代理只支持 `continuable`：立即返回持久 ID，
完成后宿主通知，之后可续话。旧一次性/双模式条目自动归一为可继续对话，保留角色 ID、
身份、模型、权限与勾选。工具统一为 `subagent_<id>_session`，不提供旧一次性工具别名或模拟。
历史 `one-shot` descriptor 的只读兼容继续保留。

## 文档

- [使用与安装](<docs/USAGE.md>)
- [模型工具契约](<docs/model-guide.md>)
- [0.3.0 升级说明（全局子代理模型）](<docs/v0.3.0.md>)
- [本次兼容迁移、验证与边界](<docs/dsh-0.2.1-compatibility.md>)

## 开发

```powershell
npm install --legacy-peer-deps
npm run typecheck
npm test -- tests/implement.spec.ts tests/subagent-compat.spec.ts
# 升级宿主时务必指定当前真实运行时，避免测到旧缓存：
$env:DSH_PROFILE_NODE_MODULES = 'C:\path\to\current-dsh\node_modules'
npm run check
```

运行期 DSH 包由 profile 的解析链提供，构建全部外部化；最小结构声明在 `src/vendor.d.ts`。
UI primitives 开发依赖钉到 `0.2.1-rc.2` 用于类型校验，浏览器由原宿主 shell 提供共享模块。

构建目标是源码仓库的 `lib/`。必须确认 profile 安装副本已同步（本机本次为 hardlink、已核对哈希），再重启原 DSH、刷新现有 GUI。
不承诺安全策略能通过热卸载无缝迁移。

## 结构

```text
src/
  index.ts             live Config、生命周期、设置与 provider 变更重算
  contract.ts          共享契约、模式与工具名
  defaults.ts          8 条内置条目及闸门文案
  normalize.ts         设置归一、旧模式迁移和严格校验
  implement.ts         实装计划与权限交集
  reconcile.ts         隐藏层、执行层、幂等工具装配
  subagent-compat.ts   activation 适配、不可变策略快照、冷恢复校验
  authoring.ts         模型自助管理工具
  client/              聊天框面板、设置页、宿主 UI 适配、设置桥与文案
  context-types.ts     所消费服务的最小结构面
  vendor.d.ts          运行期外部模块声明
```

策略目录默认为 `$DSH_HOME/plugins/dsh-ob-agent/child-policies/`（无环境变量时在 `~/.dsh` 下），
可用 `DSH_OB_AGENT_POLICY_DIR` 覆盖。**备份会话时同时备份策略目录**；缺失/坏策略拒绝冷恢复，
不会默认为完全权限。策略可能含角色提示词，不应公开或写入密钥。

## 安全边界

- `tools.restrict()` 只隐藏继承面；自有层工具必须由单调 `tools.guard()` 拒绝。
- 只读权限使用明确工具白名单，新增工具默认拒绝；空交集不降级。
- 原生非受管子代理 ID 不受本插件的快照读取校验影响，但仍按配置接受闸门管理。
- 快照是插件工具策略，不是 OS 沙箱；全权限本机进程能修改文件，不宣称能抵御恶意宿主插件。
- 本次只修当前插件，不替其他插件补伪造宿主服务，也不改变其配置或升级版本。

MIT。
