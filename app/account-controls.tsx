"use client";

import { type FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_USAGE_TABLE } from "./lib/app-config";
import { getSupabaseClient } from "./lib/supabase-client";
import type { CloudSyncController } from "./lib/use-cloud-sync";

type Props = {
  cloud: CloudSyncController;
};

type AccountUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  requestCount: number;
  estimatedCostCny: number;
  lastModel: string | null;
};

const EMPTY_USAGE: AccountUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  requestCount: 0,
  estimatedCostCny: 0,
  lastModel: null,
};

function toSafeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

function formatCost(value: number): string {
  if (value === 0) return "¥0.0000";
  if (value < 0.01) return `¥${value.toFixed(4)}`;
  return `¥${value.toFixed(2)}`;
}

function friendlyAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : "操作失败，请稍后重试";
  if (/invalid login credentials/i.test(message)) return "邮箱或密码不正确";
  if (/email not confirmed/i.test(message)) return "请先打开验证邮件完成邮箱验证";
  if (/already registered|already been registered/i.test(message)) return "该邮箱已在本项目注册，请直接登录";
  if (/password should be at least/i.test(message)) return "密码长度不足，请至少输入 6 位";
  if (/rate limit/i.test(message)) return "操作太频繁，请稍后再试";
  if (/fetch|network/i.test(message)) return "网络连接失败，本地数据不受影响";
  return message;
}

export function AccountControls({ cloud }: Props) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [usage, setUsage] = useState<AccountUsage>(EMPTY_USAGE);
  const [usageState, setUsageState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!open || !cloud.user) {
      setUsageState("idle");
      return;
    }

    const client = getSupabaseClient();
    if (!client) return;
    let cancelled = false;
    setUsageState("loading");

    void client
      .from(SUPABASE_USAGE_TABLE)
      .select(
        "prompt_tokens,completion_tokens,total_tokens,cached_tokens,request_count,estimated_cost_cny,last_model",
      )
      .eq("user_id", cloud.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setUsageState("error");
          return;
        }
        if (!data) {
          setUsage(EMPTY_USAGE);
          setUsageState("ready");
          return;
        }
        setUsage({
          promptTokens: toSafeNumber(data.prompt_tokens),
          completionTokens: toSafeNumber(data.completion_tokens),
          totalTokens: toSafeNumber(data.total_tokens),
          cachedTokens: toSafeNumber(data.cached_tokens),
          requestCount: toSafeNumber(data.request_count),
          estimatedCostCny: toSafeNumber(data.estimated_cost_cny),
          lastModel: typeof data.last_model === "string" ? data.last_model : null,
        });
        setUsageState("ready");
      });

    return () => {
      cancelled = true;
    };
  }, [cloud.user, open]);

  const close = () => {
    setOpen(false);
    setPassword("");
    setMessage("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setMessage("");
    try {
      if (panel === "register") {
        const result = await cloud.signUp(email.trim(), password);
        if (result === "verify-email") {
          setMessage("注册成功。请打开验证邮件，验证后再回到这里登录。");
        } else {
          close();
        }
      } else {
        await cloud.signIn(email.trim(), password);
        close();
      }
    } catch (error) {
      setMessage(friendlyAuthError(error));
    } finally {
      setPassword("");
      setBusy(false);
    }
  };

  const handleSync = async () => {
    setMessage("");
    try {
      await cloud.syncNow();
    } catch (error) {
      setMessage(friendlyAuthError(error));
      setOpen(true);
    }
  };

  const handleSignOut = async () => {
    setBusy(true);
    setMessage("");
    try {
      await cloud.signOut();
      close();
    } catch (error) {
      setMessage(friendlyAuthError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="account-entry" aria-label="账号和云同步">
        <button
          type="button"
          className="account-entry-button"
          onClick={() => setOpen(true)}
          disabled={!cloud.authReady}
          title={cloud.user?.email ?? "登录后可跨设备同步"}
        >
          <span className="account-entry-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M12 12.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Zm-7.1 7.1c.6-3.2 3.4-5.3 7.1-5.3s6.5 2.1 7.1 5.3" />
            </svg>
          </span>
          <span className="account-entry-copy">
            <strong>账号</strong>
            <span className="account-entry-meta">
              <i className={`sync-dot sync-${cloud.status}`} aria-hidden="true" />
              <span>{cloud.user?.email ? cloud.user.email.split("@")[0] : cloud.authReady ? cloud.statusText : "正在读取账号"}</span>
            </span>
          </span>
          <span className="account-entry-chevron" aria-hidden="true">›</span>
        </button>
      </div>

      {open && createPortal(
        <div className="account-backdrop" role="presentation" onMouseDown={close}>
          <section
            className="account-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="account-sheet-header">
              <div>
                <span>独立账号 · 数据仅属于本项目</span>
                <h2 id="account-title">{cloud.user ? "账号与同步" : "登录政治图谱"}</h2>
              </div>
              <button type="button" className="sheet-close" aria-label="关闭" onClick={close}>×</button>
            </header>

            {!cloud.configured ? (
              <div className="cloud-not-configured">
                <strong>当前为本地模式</strong>
                <p>高亮和批注会立即保存在这台设备。完成项目专属 Supabase 配置后，注册和跨设备同步会自动启用。</p>
              </div>
            ) : cloud.user ? (
              <div className="signed-in-panel">
                <div className="account-email-card">
                  <span>当前账号</span>
                  <strong>{cloud.user.email}</strong>
                </div>
                <section className="account-usage" aria-label="AI 检索累计用量">
                  <div className="account-usage-heading">
                    <strong>AI 检索累计用量</strong>
                    <span>自启用统计起</span>
                  </div>
                  {usageState === "loading" ? (
                    <div className="account-usage-loading">正在读取用量…</div>
                  ) : usageState === "error" ? (
                    <div className="account-usage-loading">暂时无法读取用量，请稍后重新打开</div>
                  ) : (
                    <>
                      <div className="account-usage-cards">
                        <div>
                          <span>总 Token</span>
                          <strong>{Math.round(usage.totalTokens).toLocaleString("zh-CN")}</strong>
                        </div>
                        <div>
                          <span>估算总费用</span>
                          <strong>{formatCost(usage.estimatedCostCny)}</strong>
                        </div>
                      </div>
                      <p className="account-usage-detail">
                        输入 {Math.round(usage.promptTokens).toLocaleString("zh-CN")}
                        {" · "}
                        输出 {Math.round(usage.completionTokens).toLocaleString("zh-CN")}
                        {" · "}
                        {Math.round(usage.requestCount).toLocaleString("zh-CN")} 次检索
                      </p>
                      <small>
                        按每次请求发生时的模型单价估算；平台优惠、代金券和后续调价可能导致账单不同。
                      </small>
                    </>
                  )}
                </section>
                <p className="account-sync-detail">
                  {cloud.statusText}
                  {cloud.lastSyncAt && ` · 最近同步 ${new Date(cloud.lastSyncAt).toLocaleString("zh-CN")}`}
                </p>
                {message && <p className="account-message error-message">{message}</p>}
                <div className="account-sheet-actions">
                  <button type="button" className="cancel-note" disabled={busy} onClick={handleSignOut}>
                    退出登录
                  </button>
                  <button
                    type="button"
                    className="save-note"
                    disabled={busy}
                    onClick={() => void handleSync()}
                  >
                    立即同步
                  </button>
                </div>
                <small className="local-data-note">退出只清除本项目登录状态，本机高亮和批注会保留。</small>
              </div>
            ) : (
              <>
                <div className="account-tabs" role="tablist" aria-label="账号操作">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={panel === "login"}
                    className={panel === "login" ? "active" : ""}
                    onClick={() => { setPanel("login"); setMessage(""); setPassword(""); }}
                  >
                    登录
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={panel === "register"}
                    className={panel === "register" ? "active" : ""}
                    onClick={() => { setPanel("register"); setMessage(""); setPassword(""); }}
                  >
                    注册新账号
                  </button>
                </div>
                <form className="account-form" onSubmit={submit}>
                  <label>
                    <span>邮箱</span>
                    <input
                      autoFocus
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="name@example.com"
                      required
                    />
                  </label>
                  <label>
                    <span>密码</span>
                    <input
                      type="password"
                      autoComplete={panel === "register" ? "new-password" : "current-password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      minLength={6}
                      required
                    />
                  </label>
                  <p className="password-privacy">密码只发送给当前项目的 Supabase Auth，本网页不会保存明文密码。</p>
                  {message && (
                    <p className={`account-message ${message.startsWith("注册成功") ? "success-message" : "error-message"}`}>
                      {message}
                    </p>
                  )}
                  <button type="submit" className="account-submit" disabled={busy || !email.trim() || password.length < 6}>
                    {busy ? "请稍候…" : panel === "register" ? "注册" : "登录"}
                  </button>
                </form>
              </>
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
