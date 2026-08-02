# `zhengzhidaotu_20260715_k4m8` Cloudflare 云同步

本项目已从 Supabase 迁移到 Cloudflare Workers + D1，登录改为 GitHub OAuth。

## 已部署资源

- Worker：`zhengzhidaotu-20260715-k4m8-api`
- Worker URL：`https://zhengzhidaotu-20260715-k4m8-api.shawnruan0218.workers.dev`
- D1：`zhengzhidaotu-20260715-k4m8-db`
- D1 ID：`1169e18d-2dee-4517-b390-a04859bdaa2b`
- GitHub OAuth App：`zhengzhidaotu-20260715-k4m8`
- 正式网站：`https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/`

GitHub OAuth Client Secret 和硅基流动 API Key 只存在 Worker Secrets 中，不进入 GitHub 或浏览器代码。

## 数据与同步

- 原 Supabase 的全部学习记录与 AI 用量已导入 D1。
- 高亮、批注和版本先写本机，页面不等待网络。
- 同步只拉取上次游标之后的变更，只上传指纹发生变化的记录。
- 相同 `item_key` 按 `updated_at` 取较新记录，软删除标记优先，不会被旧设备复活。
- 登录、页面恢复、数据变更、网络恢复、回到页面和手动点击都会触发增量同步。
- 每个 D1 查询都由 Worker 从 Session 推导 GitHub 用户 ID，前端不能指定他人的 `user_id`。

## 开发命令

```bash
npm run cf:migrate:remote
npm run cf:deploy
npm run test:sync
npm run build:pages
```

Worker 密钥使用 `wrangler secret put` 单独配置，不要把真实值写入 `.env`、文档或 Git 提交。

## 验收

1. 使用 GitHub 登录，页面回到原来位置后显示 GitHub 账号。
2. 账号面板显示已迁移的批注总数和 AI Token 用量。
3. 新增批注后先显示“本地已保存”，随后显示“云端已同步”。
4. 手机登录同一 GitHub 账号，能读到同样的版本、高亮和批注。
5. 断网修改不丢失，恢复网络后继续同步。
6. 退出仅删除 `zhengzhidaotu_20260715_k4m8-cloudflare-auth-session-v1`，本机业务数据保留。
