import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { STORAGE_KEYS } from "./app-config";

let browserClient: SupabaseClient | null | undefined;

const projectAuthStorage = {
  getItem(key: string) {
    if (!key.startsWith(STORAGE_KEYS.authSession) || typeof window === "undefined") return null;
    return window.localStorage.getItem(key);
  },
  setItem(key: string, value: string) {
    if (!key.startsWith(STORAGE_KEYS.authSession) || typeof window === "undefined") return;
    window.localStorage.setItem(key, value);
  },
  removeItem(key: string) {
    if (!key.startsWith(STORAGE_KEYS.authSession) || typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

export function getSupabaseClient(): SupabaseClient | null {
  if (browserClient !== undefined) return browserClient;
  if (!isSupabaseConfigured()) {
    browserClient = null;
    return browserClient;
  }

  browserClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    {
      auth: {
        storageKey: STORAGE_KEYS.authSession,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: projectAuthStorage,
      },
    },
  );
  return browserClient;
}
