<h1 align="center">dsh-session-cost-meter</h1>

<p align="center">会话标题栏费用胶囊：显示本轮 / 会话累计 / 项目累计 API 费用与 DeepSeek 账户余额，内置官方价格表与峰谷计价，可自定义计费标准。官方 bundle 插件，`dsh plugin --profile web add` 安装。</p>

## 能力面

| 能力面 | 说明 |
| --- | --- |
| 会话投影 `sessionCost` | 按每条消息的发送时间 × 价格表折叠成本，全历史持久化，重启不丢 |
| 标题栏胶囊 | `本轮 ¥x · 总计 ¥y · 项目 ¥z · 余额 ¥w`，每轮回复后自动刷新 |
| 项目总计 | 当前工作目录下**所有会话**的费用总和（活动会话 + 历史会话），30 秒缓存 |
| 余额查询 | 调 DeepSeek 官方 `/user/balance`（使用已存储的 API Key，30 秒缓存） |
| 设置页 | 「设置 → 会话费用计费」：编辑币种、各模型当前价 / 峰谷价、生效时间，保存即全量重算 |

## 安装

```sh
# 本地目录
dsh plugin --profile web add ./dsh-session-cost-meter

# 发布到 npm 后
dsh plugin --profile web add dsh-session-cost-meter

# 或直接从 GitHub 安装（本包无构建步骤，不需要 allowBuilds 放行）
dsh plugin --profile web add github:<owner>/dsh-session-cost-meter#<commit>
```

装完**重启 web profile**（bundle 层重启生效）。本包直接随仓库分发预构建产物（`client.js`），git 安装无需执行任何构建脚本。

## 计费标准

- 价格表：`$DSH_HOME/.dsh-cost.json`（不存在时用内置官方默认价：当前价 + 2026-08-17 起峰谷价，高峰=北京时间 9:00–12:00、14:00–18:00，闲时=高峰一半；数据来源 [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)）。
- 每条消息按其**发送时间**自动套用对应价格（8.17 前用当前价，之后按峰谷时段）。
- 金额为估算（以账单为准）；配置保存后历史总计按新价格全量重算。

## 插件管理

已装插件用 plugin-registry 的**薄控制台**管理（浏览器面板）：管理 profile 插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：`dsh plugin --profile web add <plugin-registry>/packages/plugin/console`

## 发布

```sh
npm publish          # 发布到 npm（发布前请改 package.json 的 name 为你的命名空间）
git init && git add -A && git commit -m init && git push   # 或走 GitHub 安装
```

## 开发

- Host 半：`index.mjs`（cordis 插件：投影注册 + 三条 HTTP 路由）。
- Client 半：`client.js`（预构建 CJS，`__ModuleLoader__.load` 注册，免构建步骤）。
- 修改后：重新 `dsh plugin --profile web add <路径>` 并重启 web profile 生效。
