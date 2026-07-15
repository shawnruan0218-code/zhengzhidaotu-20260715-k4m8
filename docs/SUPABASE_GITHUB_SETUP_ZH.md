# `zhengzhidaotu_20260715_k4m8` 云同步与发布配置

本说明只针对这个全新项目。不要在已有 Supabase 项目里执行 SQL，也不要把代码推送到已有 GitHub 仓库。

固定标识如下：

- 项目代号：`zhengzhidaotu_20260715_k4m8`
- Supabase 项目名称：`zhengzhidaotu-20260715-k4m8`
- 数据表：`public.zhengzhidaotu_20260715_k4m8_items`
- GitHub 仓库：`zhengzhidaotu-20260715-k4m8`
- 正式网址：`https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/`

## 一、新建独立 Supabase Project

1. 打开 [Supabase Dashboard](https://supabase.com/dashboard)，进入你要使用的 Organization。
2. 点击右上角 **New project**。
3. **Name** 填 `zhengzhidaotu-20260715-k4m8`。
4. 生成并妥善保存新的数据库密码。这个密码不放进网页或 GitHub。
5. **Region** 选择离你常用位置较近的区域。
6. 方案选择 **Free**，然后点击 **Create new project**，等待项目初始化完成。

这一步必须新建 Project。即使邮箱与其他软件相同，Auth 用户也会属于这个新 Project，必须重新注册。

## 二、创建独立数据表和 RLS

1. 在刚创建的项目左侧点击 **SQL Editor**。
2. 点击 **New query**。
3. 打开仓库中的 `supabase/zhengzhidaotu_20260715_k4m8_schema.sql`，复制全部内容到编辑器。
4. 点击右下角 **Run**。
5. 左侧进入 **Table Editor**，确认只新出现表 `zhengzhidaotu_20260715_k4m8_items`。
6. 打开该表的 **Policies**，应看到查询、添加、修改、删除四条独立策略，角色均为 `authenticated`，条件均限制 `auth.uid() = user_id`。

SQL 已明确撤销 `anon` 对该表的权限，因此未登录访问不能读取业务数据。

## 三、配置邮箱密码登录

1. 左侧点击 **Authentication**。
2. 进入 **Sign In / Providers**（部分界面显示为 **Providers**）。
3. 打开 **Email**，启用邮箱登录和密码登录。
4. 建议保持 **Confirm email** 开启，然后保存。注册后用户必须点击验证邮件。
5. 进入 **URL Configuration**。
6. **Site URL** 填：

   `https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/`

7. 在 **Redirect URLs** 添加以下三条：

   - `https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/`
   - `https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/**`
   - `http://localhost:3000/**`

8. 保存。

## 四、取得这个新项目自己的公开连接信息

1. 左侧点击齿轮 **Project Settings**。
2. 打开 **API Keys**（部分界面为 **API**）。
3. 复制这个新 Project 的 **Project URL**。
4. 复制 **Publishable key**。如果界面仍显示旧版密钥，则复制标注为公开浏览器使用的 `anon` key。
5. 不要复制任何服务器端秘密密钥，也不要把数据库密码放进前端。

本机测试时，在项目根目录新建 `.env.local`：

```text
NEXT_PUBLIC_SUPABASE_URL=刚复制的新Project URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=刚复制的新Publishable或anon key
NEXT_PUBLIC_BASE_PATH=
```

`.env.local` 已被 Git 忽略，不会提交。

## 五、新建独立 GitHub 仓库

1. 登录 GitHub，右上角点击 **+**，选择 **New repository**。
2. **Repository name** 填 `zhengzhidaotu-20260715-k4m8`。
3. 为使用 GitHub Free 的 Pages，选择 **Public**。
4. 不要勾选添加 README、`.gitignore` 或 License，然后点击 **Create repository**。
5. 将当前项目推送到这个新仓库的 `main` 分支。不要选择任何已有仓库作为远端。

## 六、给 GitHub Actions 配置公开前端变量

1. 进入新仓库 `zhengzhidaotu-20260715-k4m8`。
2. 点击 **Settings**。
3. 左侧点击 **Secrets and variables** → **Actions**。
4. 点击 **New repository secret**，添加：

   - 名称 `NEXT_PUBLIC_SUPABASE_URL`，值为新 Project URL。
   - 名称 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`，值为新 Project 的 Publishable/anon key。

5. 左侧点击 **Pages**。
6. 在 **Build and deployment** 的 **Source** 选择 **GitHub Actions**。
7. 推送到 `main` 后，打开 **Actions**，等待 `Deploy zhengzhidaotu-20260715-k4m8 to GitHub Pages` 变为绿色。
8. 发布地址应为 `https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/`。

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
