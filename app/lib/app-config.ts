export const APP_NAMESPACE = "zhengzhidaotu_20260715_k4m8";
export const APP_SLUG = "zhengzhidaotu-20260715-k4m8";
export const SUPABASE_PROJECT_NAME = APP_SLUG;
export const SUPABASE_TABLE = `${APP_NAMESPACE}_items`;
export const GITHUB_REPOSITORY = APP_SLUG;

const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const BASE_PATH = configuredBasePath
  ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

export const STORAGE_KEYS = {
  library: `${APP_NAMESPACE}-library-v1`,
  authSession: `${APP_NAMESPACE}-auth-session`,
  settings: `${APP_NAMESPACE}-settings-v1`,
  syncState: `${APP_NAMESPACE}-sync-state-v1`,
} as const;

export const CACHE_NAME = `${APP_NAMESPACE}-cache-v1`;
export const ITEM_KEY_PREFIX = `${APP_NAMESPACE}:`;
export const VERSION_ID_PREFIX = `${APP_NAMESPACE}-`;

export function withBasePath(path: string): string {
  if (!path.startsWith("/")) return path;
  if (!BASE_PATH || path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
  return `${BASE_PATH}${path}`;
}

export function scopedItemKey(logicalKey: string): string {
  return `${ITEM_KEY_PREFIX}${logicalKey}`;
}

export function isProjectStorageKey(key: string): boolean {
  return key.startsWith(`${APP_NAMESPACE}-`);
}
