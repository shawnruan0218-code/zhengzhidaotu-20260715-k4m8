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
- Supabase 邮箱密码注册、登录、退出和 Session 自动恢复
- 本地优先保存；登录后自动跨设备合并与云同步
- 断网不丢数据，恢复网络后重试；支持手动“立即同步”
- 每个账号只能通过 RLS 访问自己的云端记录

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

独立 Supabase 后端已经创建并部署：

- Project Ref：`womuvfxejdjwzcyjvclz`
- Project URL：`https://womuvfxejdjwzcyjvclz.supabase.co`
- 数据表：`public.zhengzhidaotu_20260715_k4m8_items`
- 登录回调：当前 GitHub Pages 地址与 `http://localhost:3000`

数据库结构由 `supabase/migrations/20260716080611_zhengzhidaotu_20260715_k4m8_schema.sql` 管理，Auth 配置记录在 `supabase/config.toml`。本机公开配置保存在被 Git 忽略的 `.env.local`，GitHub Pages 使用仓库 Actions Secrets。前端只使用 Publishable Key；旧式 `anon/service_role` API Keys 已停用，服务器秘密密钥不会进入前端或仓库。

配置与验收说明见 [docs/SUPABASE_GITHUB_SETUP_ZH.md](docs/SUPABASE_GITHUB_SETUP_ZH.md)。

## AI 知识点检索

`npm run build:knowledge-index` 会从 133 页 OCR 坐标生成
`public/data/knowledge-index.json`。网页会同时召回整段语义和分行/表格中的
独立知识点，再将最多 48 条候选交给项目专属的 Supabase Edge Function
`knowledge-search` 判断；模型最多返回 10 个去重后的知识区域，
因此不会把整本图谱或 API Key 放进浏览器。

推荐使用硅基流动的 `Qwen/Qwen3.5-35B-A3B`：它是每次仅激活约 3B
参数的 MoE 模型，适合本项目这种中文语义归类与候选排序，兼顾速度和判断质量。
调用使用非思考模式，网页会显示每次请求的输入、输出与总 Token。
服务器配置命令如下（不要把真实 Key 写入仓库）：

```bash
npx supabase secrets set \
  SILICONFLOW_API_KEY=你的硅基流动APIKey \
  SILICONFLOW_MODEL=Qwen/Qwen3.5-35B-A3B \
  --project-ref womuvfxejdjwzcyjvclz
```

Edge Function 通过登录用户的 Supabase Session 鉴权。本地召回只用于为模型
筛选候选，不会显示给用户；未登录或模型服务不可用时，网页会直接给出提示。

## 数据与隔离说明

所有本地存储、Supabase 表、云记录 ID、缓存和部署配置都使用唯一代号 `zhengzhidaotu_20260715_k4m8`。高亮和批注会先立即写入本机；登录后再异步合并到独立 Supabase Project。退出登录仅移除本项目 Session，本机复习数据仍会保留。

## GitHub Pages

仓库固定命名为 `zhengzhidaotu-20260715-k4m8`。`.github/workflows/deploy-pages.yml` 会构建静态站点并发布到：

`https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/`
