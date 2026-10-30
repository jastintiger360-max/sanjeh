// مهاجرت‌های پایگاه داده. زمان‌ها به‌صورت میلی‌ثانیه (BIGINT) و JSON به‌صورت TEXT ذخیره می‌شوند.
const MIGRATIONS = [
  // 1: هسته
  `
CREATE TABLE users (
  id {{ID}}, username TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','student')),
  password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, field TEXT, grade TEXT, phone TEXT, notes TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until {{BIGINT}}, must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at {{BIGINT}} NOT NULL, updated_at {{BIGINT}} NOT NULL
);
CREATE TABLE student_groups (id {{ID}}, name TEXT NOT NULL UNIQUE, description TEXT, created_at {{BIGINT}} NOT NULL);
CREATE TABLE group_members (
  group_id {{BIGINT}} NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
  user_id {{BIGINT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (group_id, user_id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id {{BIGINT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL,
  created_at {{BIGINT}} NOT NULL, last_seen {{BIGINT}} NOT NULL, expires_at {{BIGINT}} NOT NULL, ip TEXT, user_agent TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE audit_logs (
  id {{ID}}, user_id {{BIGINT}}, action TEXT NOT NULL, entity TEXT, entity_id TEXT, details TEXT, ip TEXT, created_at {{BIGINT}} NOT NULL
);
CREATE INDEX idx_audit_time ON audit_logs(created_at);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at {{BIGINT}} NOT NULL);

CREATE TABLE sources (
  id {{ID}}, title TEXT NOT NULL, field TEXT, grade TEXT, subject TEXT, book_code TEXT, print_year TEXT, edition TEXT,
  chapter TEXT, lesson_no TEXT, page_from INTEGER, page_to INTEGER, page_offset INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'textbook', authority TEXT NOT NULL DEFAULT 'personal' CHECK (authority IN ('official','supplementary','personal')),
  validation_status TEXT NOT NULL DEFAULT 'unverified' CHECK (validation_status IN ('unverified','verified','rejected')),
  file_name TEXT NOT NULL, file_path TEXT NOT NULL, mime TEXT, sha256 TEXT NOT NULL, size_bytes {{BIGINT}},
  status TEXT NOT NULL DEFAULT 'uploaded', error TEXT, page_count INTEGER, chunk_count INTEGER, flagged_count INTEGER,
  created_by {{BIGINT}}, created_at {{BIGINT}} NOT NULL, updated_at {{BIGINT}} NOT NULL
);
CREATE UNIQUE INDEX idx_sources_sha ON sources(sha256);
CREATE TABLE source_pages (
  id {{ID}}, source_id {{BIGINT}} NOT NULL REFERENCES sources(id) ON DELETE CASCADE, page_no INTEGER NOT NULL,
  text TEXT NOT NULL, method TEXT NOT NULL, confidence REAL, flagged INTEGER NOT NULL DEFAULT 0, flag_reason TEXT, has_table INTEGER NOT NULL DEFAULT 0, has_formula INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pages_source ON source_pages(source_id, page_no);
CREATE TABLE source_chunks (
  id {{ID}}, source_id {{BIGINT}} NOT NULL REFERENCES sources(id) ON DELETE CASCADE, ord INTEGER NOT NULL,
  page_start INTEGER, page_end INTEGER, chapter TEXT, topic TEXT, heading TEXT, text TEXT NOT NULL, norm_text TEXT NOT NULL,
  char_count INTEGER NOT NULL, flagged INTEGER NOT NULL DEFAULT 0, embedding TEXT
);
CREATE INDEX idx_chunks_source ON source_chunks(source_id, ord);

CREATE TABLE generation_jobs (
  id {{ID}}, created_by {{BIGINT}}, params TEXT NOT NULL, params_hash TEXT NOT NULL, status TEXT NOT NULL,
  requested_count INTEGER NOT NULL, produced_count INTEGER NOT NULL DEFAULT 0, refused_reason TEXT, error TEXT,
  provider TEXT, model TEXT, review_model TEXT, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0, est_cost REAL NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, created_at {{BIGINT}} NOT NULL, started_at {{BIGINT}}, finished_at {{BIGINT}}
);
CREATE INDEX idx_jobs_status ON generation_jobs(status);
CREATE TABLE ai_calls (
  id {{ID}}, job_id {{BIGINT}}, stage TEXT NOT NULL, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
  est_cost REAL, duration_ms INTEGER, ok INTEGER NOT NULL, error TEXT, created_at {{BIGINT}} NOT NULL
);

CREATE TABLE questions (
  id {{ID}}, uid TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('generating','pending_review','needs_revision','approved','rejected','archived')),
  current_version_id {{BIGINT}}, approved_version_id {{BIGINT}}, variant_of {{BIGINT}}, job_id {{BIGINT}}, tags TEXT NOT NULL DEFAULT '[]',
  reject_reason TEXT, created_by {{BIGINT}}, approved_by {{BIGINT}}, approved_at {{BIGINT}}, created_at {{BIGINT}} NOT NULL, updated_at {{BIGINT}} NOT NULL
);
CREATE INDEX idx_questions_status ON questions(status);
CREATE TABLE question_versions (
  id {{ID}}, question_id {{BIGINT}} NOT NULL REFERENCES questions(id), version_no INTEGER NOT NULL, origin TEXT NOT NULL,
  qtype TEXT NOT NULL, stem TEXT NOT NULL, passage TEXT, statements TEXT, table_data TEXT, image_path TEXT,
  options TEXT NOT NULL, correct_index INTEGER NOT NULL, explanation TEXT NOT NULL,
  field TEXT, grade TEXT, subject TEXT, chapter TEXT, topic TEXT, difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 4),
  cognitive_level TEXT NOT NULL, source_refs TEXT NOT NULL DEFAULT '[]', quality TEXT, quality_score REAL,
  change_note TEXT, created_by {{BIGINT}}, created_at {{BIGINT}} NOT NULL, UNIQUE (question_id, version_no)
);
CREATE TABLE question_events (
  id {{ID}}, question_id {{BIGINT}} NOT NULL, user_id {{BIGINT}}, event TEXT NOT NULL, from_status TEXT, to_status TEXT, note TEXT, created_at {{BIGINT}} NOT NULL
);

CREATE TABLE exams (
  id {{ID}}, title TEXT NOT NULL, description TEXT, field TEXT, grade TEXT, subject TEXT, topics TEXT NOT NULL DEFAULT '[]',
  duration_min INTEGER NOT NULL, start_at {{BIGINT}} NOT NULL, end_at {{BIGINT}} NOT NULL,
  points_per_question REAL NOT NULL DEFAULT 1, negative_ratio REAL NOT NULL DEFAULT 0, floor_zero INTEGER NOT NULL DEFAULT 0,
  shuffle_questions INTEGER NOT NULL DEFAULT 0, shuffle_options INTEGER NOT NULL DEFAULT 0, allow_back INTEGER NOT NULL DEFAULT 1, allow_flag INTEGER NOT NULL DEFAULT 1,
  result_policy TEXT NOT NULL DEFAULT 'after_end', explanation_policy TEXT NOT NULL DEFAULT 'after_end',
  results_released INTEGER NOT NULL DEFAULT 0, explanations_released INTEGER NOT NULL DEFAULT 0, blueprint TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  published_at {{BIGINT}}, cancelled_at {{BIGINT}}, created_by {{BIGINT}}, created_at {{BIGINT}} NOT NULL, updated_at {{BIGINT}} NOT NULL
);
CREATE TABLE exam_questions (
  id {{ID}}, exam_id {{BIGINT}} NOT NULL REFERENCES exams(id) ON DELETE CASCADE, question_id {{BIGINT}} NOT NULL REFERENCES questions(id),
  question_version_id {{BIGINT}} NOT NULL REFERENCES question_versions(id), position INTEGER NOT NULL, points REAL, UNIQUE (exam_id, question_id)
);
CREATE TABLE exam_assignments (
  id {{ID}}, exam_id {{BIGINT}} NOT NULL REFERENCES exams(id) ON DELETE CASCADE, user_id {{BIGINT}} REFERENCES users(id) ON DELETE CASCADE,
  group_id {{BIGINT}} REFERENCES student_groups(id) ON DELETE CASCADE, created_at {{BIGINT}} NOT NULL
);
CREATE INDEX idx_assign_exam ON exam_assignments(exam_id);
CREATE TABLE attempts (
  id {{ID}}, exam_id {{BIGINT}} NOT NULL REFERENCES exams(id), user_id {{BIGINT}} NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('in_progress','submitted','expired','voided')),
  started_at {{BIGINT}} NOT NULL, deadline_at {{BIGINT}} NOT NULL, submitted_at {{BIGINT}}, question_order TEXT NOT NULL, option_orders TEXT NOT NULL,
  score REAL, max_score REAL, percent REAL, correct_count INTEGER, wrong_count INTEGER, blank_count INTEGER, time_spent_ms {{BIGINT}},
  breakdown TEXT, graded_at {{BIGINT}}, UNIQUE (exam_id, user_id)
);
CREATE TABLE attempt_answers (
  attempt_id {{BIGINT}} NOT NULL REFERENCES attempts(id) ON DELETE CASCADE, exam_question_id {{BIGINT}} NOT NULL REFERENCES exam_questions(id),
  choice INTEGER, flagged INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, client_ts {{BIGINT}}, server_ts {{BIGINT}} NOT NULL,
  is_correct INTEGER, PRIMARY KEY (attempt_id, exam_question_id)
);
`,
];

export async function migrate(db) {
  const ID = db.dialect === 'postgres' ? 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const BIGINT = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const row = await db.get('SELECT MAX(version) AS v FROM schema_migrations');
  const current = Number(row?.v || 0);
  for (let i = current; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i].replaceAll('{{ID}}', ID).replaceAll('{{BIGINT}}', BIGINT);
    await db.tx(async () => {
      for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) await db.exec(stmt);
      await db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', [i + 1, Date.now()]);
    });
  }
}
