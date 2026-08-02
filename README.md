# zhengzhidaotu · `zhengzhidaotu_20260715_k4m8`

一个面向考研政治复习的互动思维导图网站。项目将政治图谱的原始版式、文字和颜色保留在网页中，并加入高亮、批注、大纲与快速翻页等复习工具。

## 主要功能

- 上下滚动和左右翻页两种阅读模式
- 页码跳转与平滑缩放
- 划词后按 `Q` 精准高亮，按 `Command/Ctrl + Z` 撤回
- 整体模式批注、整条高亮、空格键预览批注与 W 键复制悬停条目
- 只查看已高亮或已批注条目，保留上级节点和原始连线
- 三级大纲导航，点击章节或考点快速定位
- 全书文字词条索引；可粘贴题目、选项或知识点进行 AI 检索
- 点击检索结果自动跳到图谱原位置，并用三秒渐变虚线框定位
- 支持创建多个独立复习版本
- GitHub 登录、退出和 90 天 Session 自动恢复
- 本地优先保存；登录后自动跨设备合并与云同步
- 断网不丢数据，恢复网络后重试；支持手动“立即同步”
- 每个 GitHub 账号只能通过 Worker 访问自己的 D1 记录

## 本地运行

需要 Node.js `22.13.0` 或更高版本。

```bash
npm install
npm run dev
```

默认访问地址为 `http://localhost:3000`。发布前可运行：

```bash
npm run build
npm run test
```

## 云同步配置

免费 Cloudflare 后端已创建并部署：

- Worker：`https://zhengzhidaotu-20260715-k4m8-api.shawnruan0218.workers.dev`
- D1：`zhengzhidaotu-20260715-k4m8-db`
- GitHub OAuth App：`zhengzhidaotu-20260715-k4m8`
- 登录回调：Worker 的 `/auth/callback`

数据库结构由 `cloudflare/migrations/0001_initial.sql` 管理，Worker 由 `cloudflare/src/index.ts` 实现。GitHub OAuth Client Secret 和硅基流动 API Key 只保存在 Cloudflare Worker Secrets，不会进入前端或仓库。

配置与验收说明见 [docs/CLOUDFLARE_GITHUB_SETUP_ZH.md](docs/CLOUDFLARE_GITHUB_SETUP_ZH.md)。

## AI 知识点检索

`npm run build:knowledge-index` 会从 133 页 OCR 坐标生成
`public/data/knowledge-index.json`。网页会同时召回整段语义和分行/表格中的
独立知识点，再将最多 48 条候选交给项目专属的 Cloudflare Worker
`knowledge-search` 判断；模型最多返回 10 个去重后的知识区域，
因此不会把整本图谱或 API Key 放进浏览器。

推荐使用硅基流动的 `Qwen/Qwen3.5-35B-A3B`：它是每次仅激活约 3B
参数的 MoE 模型，适合本项目这种中文语义归类与候选排序，兼顾速度和判断质量。
调用使用非思考模式，网页会显示每次请求的输入、输出与总 Token。
服务器配置命令如下（不要把真实 Key 写入仓库）：

```bash
npx wrangler secret put SILICONFLOW_API_KEY --config cloudflare/wrangler.jsonc
```

Worker 通过登录用户的 GitHub Session 鉴权。本地召回只用于为模型
筛选候选，不会显示给用户；未登录或模型服务不可用时，网页会直接给出提示。

## 数据与隔离说明

所有本地存储、D1 表、云记录 ID、缓存和部署配置都使用唯一代号 `zhengzhidaotu_20260715_k4m8`。高亮和批注会先立即写入本机；登录后再异步增量合并到 D1。退出登录仅移除本项目 Session，本机复习数据仍会保留。运行时已完全不依赖 Supabase。

## GitHub Pages

仓库固定命名为 `zhengzhidaotu-20260715-k4m8`。`.github/workflows/deploy-pages.yml` 会构建静态站点并发布到：

`https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/`
