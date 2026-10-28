# codex-zcode-connector

Codex 委派 ZCode 执行任务，接收提问、授权和结果。Windows · Node.js 22+。

## 安装

```powershell
npm install -g https://github.com/yuchen-ya/codex-zcode-connector/releases/download/v0.6.0/codex-zcode-connector-0.6.0.tgz
codex-zcode install
codex-zcode launch --workspace 'E:\your-project'
```

重载 Codex，说“交给 ZCode 完成这个功能，你负责安排、验收和修复”。Codex 先查询现状，再确认模型、执行安排、权限和工作区；本轮后续修复沿用确认结果。端口占用时先退出旧调试实例。

```powershell
codex-zcode inspect --json
codex-zcode delegate --workspace 'E:\your-project' '检查这个项目'
codex-zcode wait TASK_ID --json
```

必须指定工作区（`--workspace` 或 `ZCODE_WORKSPACE`），无临时目录默认值。仅支持已在 ZCode 登记的本地项目；发送前切换并核对路径，忙碌任务或未发送草稿会阻止提交。任务回执含工作区，等待和回复绑定原任务。

## 模型

可用供应商和模型以 `inspect` 查询为准。

| 模型 | 视觉 | 能力 |
|---|---|---|
| GLM-5.3 | 不支持 | 更强 |
| GLM-5.3-Flash | 支持 | 较弱 |

用 `--provider`、`--model` 切换；默认保留当前选择，思考强度最高。目前只传文本。

本机 CDP 后台操作，不回退系统键鼠。ZCode 权限独立，不自动提权。任务串行；完成反馈需持续等待，Codex 关闭后不会被唤醒。

## 卸载

```powershell
codex-zcode uninstall
npm uninstall -g codex-zcode-connector
```

开发：`npm test` · 打包：`npm run release` · MCP：`codex-zcode install --mcp`

MIT · 基于 [dsh-zcode-connector](https://github.com/ZhaoAndy821/dsh-zcode-connector)
