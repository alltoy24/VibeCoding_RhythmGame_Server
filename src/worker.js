const JUDGMENT_KEYS = ["absoluteSync", "tpPerfect", "perfect", "good", "bad", "miss"];
const STANDARD_WEIGHTS = { absoluteSync: 0, tpPerfect: 1, perfect: 1, good: 0.7, bad: 0.4, miss: 0 };
const PRECISION_WEIGHTS = { absoluteSync: 1, tpPerfect: 0.9, perfect: 0.8, good: 0.6, bad: 0.4, miss: 0 };
const STANDARD_JUDGMENT_PORTION = 0.70;
const STANDARD_COMBO_PORTION = 0.30;
const LEGACY_SIGNATURE_SALT = "WebBeat_Secure_Key_2026_Ver42";
const STANDARD_GRADE_TABLE = [
  { min: 950000, label: "S+", kind: "grade-splus" },
  { min: 900000, label: "S", kind: "grade-s" },
  { min: 850000, label: "A+", kind: "grade-aplus" },
  { min: 800000, label: "A", kind: "grade-a" },
  { min: 700000, label: "B", kind: "grade-b" },
  { min: 600000, label: "C", kind: "grade-c" },
  { min: 0, label: "FAILED", kind: "grade-failed" }
];

function corsHeaders(request, env) {
  const configured = String(env.ALLOWED_ORIGIN || "*").split(",").map((value) => value.trim());
  const requested = request.headers.get("Origin");
  const origin = configured.includes("*")
    ? "*"
    : (requested && configured.includes(requested) ? requested : configured[0]);

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(request, env, value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request, env) }
  });
}

function cleanText(value, label, maxLength, { optional = false } = {}) {
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new Error(`Invalid ${label}`);
  return text;
}

function cleanInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid ${label}`);
  return number;
}

function isPrecisionEligibleDiff(diff) {
  return !/^(?:normal|hard)(?:_|$)/i.test(String(diff || "").replace(/__precision$/i, ""));
}

function normaliseJudgments(details, totalNotes) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new Error("Judgment details are required");
  }

  const stats = {};
  for (const key of JUDGMENT_KEYS) {
    // 이전 일반 모드 저장 형식에는 absoluteSync가 없을 수 있다.
    const value = key === "absoluteSync" && details[key] === undefined ? 0 : details[key];
    stats[key] = cleanInteger(value, key);
  }

  if (JUDGMENT_KEYS.reduce((sum, key) => sum + stats[key], 0) !== totalNotes) {
    throw new Error("Judgment total does not match total notes");
  }
  return stats;
}

function calculateStandardScore(stats, maxCombo, totalNotes) {
  const judgmentRatio = JUDGMENT_KEYS.reduce(
    (sum, key) => sum + stats[key] * STANDARD_WEIGHTS[key], 0
  ) / totalNotes;
  const comboRatio = Math.max(0, Math.min(1, maxCombo / totalNotes));
  const score = 1000000 * (
    (judgmentRatio * STANDARD_JUDGMENT_PORTION) +
    (comboRatio * STANDARD_COMBO_PORTION)
  );
  return Math.floor(score + 0.0000001);
}

function calculatePrecisionScore(stats, totalNotes) {
  return Math.floor((1000000 * JUDGMENT_KEYS.reduce(
    (sum, key) => sum + stats[key] * PRECISION_WEIGHTS[key], 0
  )) / totalNotes);
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function signaturesFor({ userId, score, maxCombo, mode, stats, totalNotes }, salt) {
  const judgeSignature = [
    stats.absoluteSync,
    stats.tpPerfect,
    stats.perfect,
    stats.good,
    stats.bad,
    stats.miss,
    totalNotes
  ].join(":");

  return {
    standard: base64Utf8(`${userId}_${score}_${maxCombo}_${judgeSignature}_${salt}`),
    precision: base64Utf8(`${userId}_${score}_${maxCombo}_${mode}_${judgeSignature}_${salt}`),
    legacy: base64Utf8(`${userId}_${score}_${maxCombo}_${salt}`)
  };
}

function verifyScorePayload(body, env) {
  const userId = cleanText(body?.userId, "user ID", 128);
  const userName = cleanText(body?.userName || "GUEST", "user name", 40);
  const song = cleanText(body?.song, "song", 160);
  const diff = cleanText(body?.diff, "difficulty", 100);
  const mode = body?.mode === undefined ? "standard" : String(body.mode);
  if (mode !== "standard" && mode !== "precision") throw new Error("Invalid score mode");
  if (mode === "precision" && !isPrecisionEligibleDiff(diff)) {
    throw new Error("Precision mode is only available for Troll and special charts");
  }

  const totalNotes = cleanInteger(body?.totalNotes, "total notes", { min: 1, max: 200000 });
  const stats = normaliseJudgments(body?.details, totalNotes);
  if (mode === "standard" && stats.absoluteSync !== 0) throw new Error("Invalid standard judgments");

  const suppliedScore = cleanInteger(body?.score, "score", { min: 0, max: 1000000 });
  const maxCombo = cleanInteger(body?.maxCombo ?? 0, "max combo", { min: 0, max: totalNotes });
  const comboBreaks = stats.bad + stats.miss;
  if (maxCombo > totalNotes - comboBreaks) throw new Error("Invalid max combo for judgments");
  if (comboBreaks === 0 && maxCombo !== totalNotes) throw new Error("Full combo is required for these judgments");
  const expectedScore = mode === "precision"
    ? calculatePrecisionScore(stats, totalNotes)
    : calculateStandardScore(stats, maxCombo, totalNotes);
  const level = cleanInteger(body?.level ?? 1, "level", { min: 1, max: 9999 });
  const signature = cleanText(body?.signature, "signature", 4096);

  if (suppliedScore !== expectedScore) throw new Error("Score does not match judgments");

  const salt = String(env.SCORE_SIGNATURE_SALT || LEGACY_SIGNATURE_SALT);
  const signatures = signaturesFor({ userId, score: expectedScore, maxCombo, mode, stats, totalNotes }, salt);
  const validSignature = mode === "precision"
    ? signature === signatures.precision
    : signature === signatures.standard || signature === signatures.legacy;
  if (!validSignature) throw new Error("Data Tampering Detected (Signature Mismatch)");

  return { userId, userName, song, diff, mode, stats, totalNotes, score: expectedScore, maxCombo, level };
}

async function saveScore(request, env) {
  const payload = verifyScorePayload(await request.json(), env);
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (user_id, level, xp, created_at, updated_at)
       VALUES (?1, ?2, 0, ?3, ?3)
       ON CONFLICT(user_id) DO UPDATE SET level = MAX(users.level, excluded.level), updated_at = excluded.updated_at`
    ).bind(payload.userId, payload.level, now),
    env.DB.prepare(
      `INSERT INTO score_records (
        user_id, user_name, song, diff, mode, score, level,
        absolute_sync, tp_perfect, perfect, good, bad, miss, total_notes, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
      ON CONFLICT(user_id, song, diff) DO UPDATE SET
        user_name = excluded.user_name,
        level = MAX(score_records.level, excluded.level),
        mode = excluded.mode,
        score = MAX(score_records.score, excluded.score),
        absolute_sync = CASE WHEN excluded.score >= score_records.score THEN excluded.absolute_sync ELSE score_records.absolute_sync END,
        tp_perfect = CASE WHEN excluded.score >= score_records.score THEN excluded.tp_perfect ELSE score_records.tp_perfect END,
        perfect = CASE WHEN excluded.score >= score_records.score THEN excluded.perfect ELSE score_records.perfect END,
        good = CASE WHEN excluded.score >= score_records.score THEN excluded.good ELSE score_records.good END,
        bad = CASE WHEN excluded.score >= score_records.score THEN excluded.bad ELSE score_records.bad END,
        miss = CASE WHEN excluded.score >= score_records.score THEN excluded.miss ELSE score_records.miss END,
        total_notes = CASE WHEN excluded.score >= score_records.score THEN excluded.total_notes ELSE score_records.total_notes END,
        updated_at = CASE WHEN excluded.score >= score_records.score THEN excluded.updated_at ELSE score_records.updated_at END`
    ).bind(
      payload.userId, payload.userName, payload.song, payload.diff, payload.mode, payload.score, payload.level,
      payload.stats.absoluteSync, payload.stats.tpPerfect, payload.stats.perfect, payload.stats.good,
      payload.stats.bad, payload.stats.miss, payload.totalNotes, now
    )
  ]);

  return { success: true, score: payload.score };
}

async function getRanking(env, song, diff) {
  const { results } = await env.DB.prepare(
    `SELECT user_id AS userId, user_name AS userName, score, level, mode,
            absolute_sync AS absoluteSync, tp_perfect AS tpPerfect, perfect, good, bad, miss,
            total_notes AS totalNotes
       FROM score_records
      WHERE song = ?1 AND diff = ?2
      ORDER BY score DESC, updated_at ASC
      LIMIT 50`
  ).bind(song, diff).all();
  return results.map((record) => ({ ...record, ...getRankingStatus(record) }));
}

function getRankingStatus(record) {
  const totalNotes = Number(record.totalNotes) || 0;
  const absoluteSync = Number(record.absoluteSync) || 0;
  const tpPerfect = Number(record.tpPerfect) || 0;
  const perfect = Number(record.perfect) || 0;
  const bad = Number(record.bad) || 0;
  const miss = Number(record.miss) || 0;

  if (record.mode === "precision") {
    const fullCombo = totalNotes > 0 && bad + miss === 0;
    const trollBeat = totalNotes > 0 && absoluteSync + tpPerfect + perfect === totalNotes;
    if (absoluteSync === totalNotes && totalNotes > 0) return { rankLabel: "|SYNC| · TB", rankKind: "sync-full" };
    if (trollBeat) return { rankLabel: "TB", rankKind: "tb" };
    if (fullCombo) return { rankLabel: "FC", rankKind: "fc" };
    return { rankLabel: "SYNC", rankKind: "sync" };
  }

  if (totalNotes > 0 && tpPerfect + perfect === totalNotes) {
    return { rankLabel: "TB", rankKind: "tb" };
  }
  if (totalNotes > 0 && bad + miss === 0) {
    return { rankLabel: "FC", rankKind: "fc" };
  }
  const grade = STANDARD_GRADE_TABLE.find((item) => Number(record.score) >= item.min)
    || STANDARD_GRADE_TABLE[STANDARD_GRADE_TABLE.length - 1];
  return { rankLabel: grade.label, rankKind: grade.kind };
}

async function getUser(env, userId) {
  const user = await env.DB.prepare(
    `SELECT user_id AS userId, nickname, level, xp, rating, tier, match_count AS matchCount, win_count AS winCount
       FROM users WHERE user_id = ?1`
  ).bind(userId).first();
  return user || { userId, level: 1, xp: 0, nickname: null, rating: 1000, tier: "Bronze", matchCount: 0, winCount: 0 };
}

async function updateUser(request, env) {
  const body = await request.json();
  const userId = cleanText(body?.userId, "user ID", 128);
  const current = await getUser(env, userId);
  const hasLevel = body?.level !== undefined;
  const hasXp = body?.xp !== undefined;
  const hasNickname = body?.nickname !== undefined;
  const level = hasLevel ? cleanInteger(body.level, "level", { min: 1, max: 9999 }) : current.level;
  const xp = hasXp ? cleanInteger(body.xp, "xp", { min: 0, max: 2000000000 }) : current.xp;
  const nickname = hasNickname
    ? (body.nickname === null || String(body.nickname).trim() === "" ? null : cleanText(body.nickname, "nickname", 12))
    : current.nickname;
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      `INSERT INTO users (user_id, nickname, level, xp, rating, tier, match_count, win_count, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT(user_id) DO UPDATE SET
         nickname = excluded.nickname, level = excluded.level, xp = excluded.xp, updated_at = excluded.updated_at`
    ).bind(userId, nickname, level, xp, current.rating || 1000, current.tier || "Bronze", current.matchCount || 0, current.winCount || 0, now)
  ];

  if (nickname) {
    statements.push(env.DB.prepare("UPDATE score_records SET user_name = ?1 WHERE user_id = ?2").bind(nickname, userId));
  }
  await env.DB.batch(statements);
  return { success: true };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        await env.DB.prepare("SELECT 1 AS ok").first();
        return json(request, env, { ok: true, service: "webbeat-api", storage: "D1" });
      }
      if (request.method === "POST" && url.pathname === "/api/score") {
        return json(request, env, await saveScore(request, env));
      }
      if (request.method === "GET" && segments[0] === "api" && segments[1] === "ranking" && segments.length === 4) {
        const song = cleanText(segments[2], "song", 160);
        const diff = cleanText(segments[3], "difficulty", 100);
        return json(request, env, await getRanking(env, song, diff));
      }
      if (request.method === "GET" && segments[0] === "api" && segments[1] === "user" && segments.length === 3) {
        const userId = cleanText(segments[2], "user ID", 128);
        return json(request, env, await getUser(env, userId));
      }
      if (request.method === "POST" && url.pathname === "/api/user/update") {
        return json(request, env, await updateUser(request, env));
      }
      return json(request, env, { error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      const isClientError = /^(Invalid|Judgment|Score does not|Precision mode|Data Tampering|user ID|user name|song|difficulty|signature|nickname)/.test(message);
      console.error("[webbeat-api]", message);
      return json(request, env, { success: false, error: isClientError ? message : "Database request failed" }, isClientError ? 400 : 500);
    }
  }
};
