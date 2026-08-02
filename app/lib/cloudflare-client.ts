import { CLOUDFLARE_API_URL, STORAGE_KEYS } from "./app-config";

export type CloudflareUser = {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
};

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  authenticated?: boolean;
};

export class CloudflareHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CloudflareHttpError";
    this.status = status;
  }
}

export function isCloudflareConfigured(): boolean {
  return Boolean(CLOUDFLARE_API_URL);
}

export function readCloudflareSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEYS.cloudflareAuthSession);
  } catch {
    return null;
  }
}

export function writeCloudflareSession(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEYS.cloudflareAuthSession, token);
  } catch {
    // The user can still continue in local-only mode if storage is blocked.
  }
}

export function clearCloudflareSession(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEYS.cloudflareAuthSession);
  } catch {
    // Ignore storage failures while signing out.
  }
}

export function consumeCloudflareCallback(): boolean {
  if (typeof window === "undefined" || !window.location.hash) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("cloudflare_auth");
  if (!token) return false;
  writeCloudflareSession(token);
  params.delete("cloudflare_auth");
  const suffix = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${suffix ? `#${suffix}` : ""}`,
  );
  return true;
}

export function cloudflareLoginUrl(returnTo = window.location.href): string {
  const url = new URL(`${CLOUDFLARE_API_URL}/auth/login`);
  const normalizedReturn = new URL(returnTo);
  normalizedReturn.hash = "";
  url.searchParams.set("return_to", normalizedReturn.toString());
  return url.toString();
}

export async function cloudflareRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  if (!CLOUDFLARE_API_URL) throw new Error("Cloudflare 云端尚未配置");
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }
  if (options.authenticated !== false) {
    const token = readCloudflareSession();
    if (!token) throw new Error("请先使用 GitHub 登录");
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${CLOUDFLARE_API_URL}${path}`, {
    ...options,
    headers,
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) clearCloudflareSession();
    throw new CloudflareHttpError(
      response.status,
      typeof payload.error === "string"
        ? payload.error
        : response.status === 401
          ? "GitHub 登录状态已失效，请重新登录"
          : "云端暂时不可用",
    );
  }
  return payload as T;
}
