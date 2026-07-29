export function shouldRetryKnowledgeRequest(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function knowledgeHttpErrorMessage(
  status: number,
  serverMessage?: string,
): string {
  if (serverMessage && !/edge function returned a non-2xx status code/i.test(serverMessage)) {
    return serverMessage;
  }
  if (status === 401 || status === 403) {
    return "登录状态已失效，请重新登录后检索";
  }
  if (status === 408 || status === 504) {
    return "AI 检索等待时间过长，请重新检索";
  }
  if (status === 429) {
    return "当前检索人数较多，请稍等几秒后重试";
  }
  if (status >= 500) {
    return "AI 服务暂时繁忙，请重新检索";
  }
  return "AI 检索未能完成，请重新检索";
}

export function friendlyKnowledgeError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message.trim() : "";
  if (
    /edge function returned a non-2xx status code/i.test(message) ||
    /functions?httperror/i.test(message)
  ) {
    return "AI 服务暂时繁忙，请重新检索";
  }
  if (
    /failed to fetch/i.test(message) ||
    /networkerror/i.test(message) ||
    /load failed/i.test(message)
  ) {
    return "网络连接不稳定，请检查网络后重新检索";
  }
  return message || "检索失败，请稍后重试";
}

export function isTransientKnowledgeError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message.trim() : String(reason ?? "");
  return /硅基流动暂时不可用|AI 服务暂时繁忙|当前检索人数较多|服务连接不稳定|网络连接不稳定|edge function returned a non-2xx status code|functions?httperror|failed to fetch|networkerror|load failed/i.test(
    message,
  );
}

export function waitForKnowledgeRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
