CREATE TABLE IF NOT EXISTS zhengzhidaotu_20260715_k4m8_users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zhengzhidaotu_20260715_k4m8_oauth_states (
  state_hash TEXT PRIMARY KEY,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zhengzhidaotu_20260715_k4m8_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES zhengzhidaotu_20260715_k4m8_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS zhengzhidaotu_20260715_k4m8_sessions_user_idx
  ON zhengzhidaotu_20260715_k4m8_sessions(user_id);

CREATE TABLE IF NOT EXISTS zhengzhidaotu_20260715_k4m8_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES zhengzhidaotu_20260715_k4m8_users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_data TEXT NOT NULL DEFAULT '{}',
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  server_changed_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(user_id, item_key)
);

CREATE INDEX IF NOT EXISTS zhengzhidaotu_20260715_k4m8_items_delta_idx
  ON zhengzhidaotu_20260715_k4m8_items(user_id, server_changed_at, item_key);

CREATE TABLE IF NOT EXISTS zhengzhidaotu_20260715_k4m8_ai_usage (
  user_id TEXT PRIMARY KEY REFERENCES zhengzhidaotu_20260715_k4m8_users(id) ON DELETE CASCADE,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  estimated_cost_cny REAL NOT NULL DEFAULT 0,
  last_model TEXT,
  updated_at TEXT NOT NULL
);
