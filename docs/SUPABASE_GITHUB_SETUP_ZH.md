# `zhengzhidaotu_20260715_k4m8` 云同步与发布配置

本说明只针对这个全新项目。后端与 GitHub Pages 已完成配置；不要在已有 Supabase 项目里重复执行 SQL，也不要把代码推送到其他 GitHub 仓库。

固定标识如下：

- 项目代号：`zhengzhidaotu_20260715_k4m8`
- Supabase 项目名称：`zhengzhidaotu-20260715-k4m8`
- Supabase Project Ref：`womuvfxejdjwzcyjvclz`
- Supabase Project URL：`https://womuvfxejdjwzcyjvclz.supabase.co`
- 数据表：`public.zhengzhidaotu_20260715_k4m8_items`
- GitHub 仓库：`zhengzhidaotu-20260715-k4m8`
- 正式网址：`https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/`

## 一、独立 Supabase Project（已完成）

- 已创建独立 Organization：`zhengzhidaotu-20260715-k4m8-org`
- 已创建 Free Project：`zhengzhidaotu-20260715-k4m8`
- 区域：Singapore
- 数据库密码只保存在本机系统钥匙串，不进入网页、GitHub 或文档
- 当前项目拥有独立 Auth 用户池；即使邮箱与其他软件相同，也必须在本项目重新注册

## 二、独立数据表和 RLS（已完成）

迁移文件 `supabase/migrations/20260716080611_zhengzhidaotu_20260715_k4m8_schema.sql` 已部署。查询、添加、修改、删除四条策略均只允许 `authenticated`，并限制 `auth.uid() = user_id`。

SQL 已明确撤销 `anon` 对该表的权限。实际请求验证结果为 HTTP 401，未登录访问不能读取业务数据。

## 三、邮箱密码登录（已完成）

- 邮箱注册和密码登录已启用
- 邮箱验证已启用
- Session 自动刷新与 refresh token rotation 已启用
- 匿名登录已禁用
- Site URL：`https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/`
- Redirect URLs：正式网址、正式网址通配路径、`http://localhost:3000/` 与本机通配路径

## 四、公开连接信息（已完成）

- 本机 `.env.local` 已配置且被 Git 忽略
- 前端只使用新的 `sb_publishable_…` Key
- 未使用 Secret Key 或 `service_role`
- 旧式 `anon/service_role` API Keys 已停用

## 五、独立 GitHub 仓库（已完成）

当前项目只连接到 `shawnruan0218-code/zhengzhidaotu-20260715-k4m8`。

## 六、GitHub Actions 公开前端变量（已完成）

当前仓库已配置：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

推送到 `main` 后，GitHub Actions 会自动构建并发布到正式网址。

## 七、人工验收顺序

1. 用一个未在本项目注册的邮箱注册，完成验证，再登录。
2. 高亮几个字并添加一条批注，确认状态先显示“本地已保存”，随后显示“云端已同步”。
3. 刷新页面，确认仍保持登录且内容存在。
4. 退出登录，确认高亮和批注仍留在本机；再次登录后可同步。
5. 手机打开正式网址，用同一账号登录，点击“立即同步”，确认数据一致。
6. 在手机打开飞行模式后修改内容，确认提示“离线 · 本地已保存”；恢复网络后等待自动同步。
7. 再注册第二个邮箱账号。第二个账号不应看到第一个账号的云端内容。注意：本地优先设计会保留同一浏览器现有本机数据，首次登录第二账号时会把这些本地内容合并进第二账号；如需做严格隔离测试，应使用无痕窗口或另一浏览器注册第二账号。

## 八、系统行为说明

- 用户操作立即写入项目专属 localStorage，不等待网络。
- 登录成功、恢复 Session、数据变化、每 30 秒、窗口重新聚焦、页面从后台恢复、网络恢复以及点击“立即同步”时都会触发同步。
- 云端读取每页 500 条，直到读完；写入每批 100 条。
- 相同 `item_key` 按 `updated_at` 保留较新版本；同一时间戳下删除标记优先。
- 删除标记保留 90 天，成功同步后才清理过期标记。
- 本项目不会调用 `localStorage.clear()`，也不会删除其他前缀的缓存。
- 所用功能均为 Supabase Auth、Postgres、RLS 和 GitHub Pages 的免费可用能力。
