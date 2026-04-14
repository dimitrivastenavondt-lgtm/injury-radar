-- Injury Radar – database schema
-- Plak dit volledig in Supabase > SQL Editor > Run

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_name     TEXT,
  child_name      TEXT NOT NULL,
  age             INT,
  club            TEXT,
  position        TEXT,
  child_phone     TEXT UNIQUE NOT NULL,
  parent_phone    TEXT,
  active          BOOLEAN DEFAULT true,
  consent_ts      TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  day_type        TEXT CHECK (day_type IN ('rust','training','wedstrijd')),
  rpe             INT,
  sleep           INT,
  fatigue         INT,
  pain_location   TEXT,
  pain_score      INT,
  daily_load      FLOAT,
  acute_7d        FLOAT,
  chronic_28d_avg FLOAT,
  acwr            FLOAT,
  risk_score      INT,
  risk_color      TEXT CHECK (risk_color IN ('groen','geel','rood')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, date)
);

-- Index for fast ACWR lookups
CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date ON daily_logs(user_id, date DESC);
