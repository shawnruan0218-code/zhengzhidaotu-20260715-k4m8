"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnnotationCalendar } from "./annotation-calendar";
import { cloudflareRequest } from "./lib/cloudflare-client";
import type { AnnotationRecord } from "./lib/study-types";
import type { CloudSyncController } from "./lib/use-cloud-sync";

type Props = {
  cloud: CloudSyncController;
  annotationStats: {
    today: number;
    total: number;
  };
  annotationRecords: AnnotationRecord[];
  onJumpToAnnotation: (record: AnnotationRecord) => void;
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
  if (/登录状态已失效/i.test(message)) return "GitHub 登录状态已失效，请重新登录";
  if (/rate limit/i.test(message)) return "操作太频繁，请稍后再试";
  if (/fetch|network/i.test(message)) return "网络连接失败，本地数据不受影响";
  return message;
}

export function AccountControls({
  cloud,
  annotationStats,
  annotationRecords,
  onJumpToAnnotation,
}: Props) {
  const [open, setOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [usage, setUsage] = useState<AccountUsage>(EMPTY_USAGE);
  const [usageState, setUsageState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!open || !cloud.user) {
      return;
    }

    let cancelled = false;
    setUsageState("loading");

    void cloudflareRequest<{ usage: Record<string, unknown> | null }>("/usage", { method: "GET" })
      .then(({ usage: data }) => {
        if (cancelled) return;
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
      })
      .catch(() => {
        if (!cancelled) setUsageState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [cloud.user, open]);

  const close = () => {
    setOpen(false);
    setMessage("");
  };

  const handleSignIn = () => {
    setMessage("");
    cloud.signIn();
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

  const handleAnnotationJump = (record: AnnotationRecord) => {
    close();
    onJumpToAnnotation(record);
  };

  return (
    <>
      <div className="account-entry" aria-label="账号和云同步">
        <button
          type="button"
          className="account-entry-button"
          onClick={() => setOpen(true)}
          disabled={!cloud.authReady}
          title={cloud.user?.email ?? (cloud.user ? `@${cloud.user.login}` : "使用 GitHub 登录后可跨设备同步")}
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
              <span>{cloud.user ? cloud.user.name || cloud.user.login : cloud.authReady ? cloud.statusText : "正在读取账号"}</span>
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
                <p>高亮和批注会立即保存在这台设备。完成项目专属 Cloudflare 免费云端配置后，跨设备同步会自动启用。</p>
              </div>
            ) : cloud.user ? (
              <div className="signed-in-panel">
                <div className="account-email-card">
                  <span>当前账号</span>
                  <strong>{cloud.user.name || cloud.user.login}</strong>
                  <small>@{cloud.user.login}{cloud.user.email ? ` · ${cloud.user.email}` : ""}</small>
                </div>
                <section className="account-annotation-stats" aria-label="批注统计">
                  <div className="account-usage-heading">
                    <strong>批注统计</strong>
                    <span>全部复习版本</span>
                  </div>
                  <div className="account-annotation-cards">
                    <div>
                      <span>今天已批注词条</span>
                      <strong>{annotationStats.today.toLocaleString("zh-CN")}</strong>
                    </div>
                    <div>
                      <span>累计批注</span>
                      <strong>{annotationStats.total.toLocaleString("zh-CN")}</strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="account-annotation-calendar-toggle"
                    aria-expanded={calendarOpen}
                    onClick={() => setCalendarOpen((current) => !current)}
                  >
                    <span>{calendarOpen ? "收起批注日历" : "按日历查看批注记录"}</span>
                    <i aria-hidden="true">{calendarOpen ? "⌃" : "⌄"}</i>
                  </button>
                  {calendarOpen && (
                    <AnnotationCalendar
                      records={annotationRecords}
                      onJump={handleAnnotationJump}
                    />
                  )}
                  <small>累计数包含原有批注；今日新增从统计功能启用后开始记录。</small>
                </section>
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
              <div className="github-login-panel">
                <div className="github-login-mark" aria-hidden="true">GH</div>
                <strong>使用 GitHub 登录</strong>
                <p>登录后会把本机已有批注安全迁移到 Cloudflare D1，并启用免费增量同步。</p>
                {message && <p className="account-message error-message">{message}</p>}
                <button type="button" className="account-submit" onClick={handleSignIn}>
                  继续使用 GitHub
                </button>
                <small className="local-data-note">无需绑定银行卡；退出登录不会删除本机批注。</small>
              </div>
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
