require("dotenv").config(); // .env 파일 로드
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet"); // 보안 헤더 설정
const rateLimit = require("express-rate-limit"); // 도배 방지

const app = express();

// ==========================================
// ★ 1. 보안 미들웨어 설정
// ==========================================
app.use(helmet()); // HTTP 헤더 보안
app.use(express.json({ limit: '10kb' })); // 요청 데이터 크기 제한 (DDOS 방지)
app.use(cors());

// [도배 방지] 15분에 100번까지만 요청 가능 (IP 기준)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." }
});
app.use("/api/", limiter);

// ==========================================
// ★ 2. MongoDB 연결 (환경변수 사용)
// ==========================================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB 연결 성공! (SECURE MODE)"))
  .catch(err => console.error("🔥 DB 연결 실패:", err));

// ==========================================
// ★ 3. 데이터 모델
// ==========================================
const scoreSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  song: String,
  diff: String,
  score: Number,
  level: Number,
  timestamp: { type: Date, default: Date.now } // 기록 시간 자동 저장
});
scoreSchema.index({ userId: 1, song: 1, diff: 1 }, { unique: true });
const Score = mongoose.model("Score", scoreSchema);

const userSchema = new mongoose.Schema({
  userId: String,
  nickname: String,
  level: Number,
  xp: Number
});
const User = mongoose.model("User", userSchema);

// ==========================================
// ★ 4. 보안 검증 함수 (핵심!)
// ==========================================
const verifySignature = (req, res, next) => {
    // 클라이언트에서 보낸 데이터
    const { userId, score, signature, playTime } = req.body;
    
    // 1. 필수 데이터 누락 확인
    if (!userId || !score || !signature) {
        return res.status(400).json({ error: "잘못된 요청입니다." });
    }

    // 2. 플레이 타임 검증 (최소 10초)
    // (서버에서도 한 번 더 체크)
    if (playTime && playTime < 10000) {
        console.warn(`🚨 [HACK DETECTED] PlayTime too short: ${playTime}ms (${userId})`);
        return res.status(403).json({ error: "비정상적인 플레이 감지됨" });
    }

    // 3. 서명(Signature) 위변조 검증
    // 서버가 가진 비밀키(SECRET_SALT)로 똑같이 만들어보고, 클라이언트 것과 비교
    // 클라이언트 로직: btoa(Math.round(score) + secret + userId)
    // 주의: 클라이언트 로직과 토씨 하나 틀리지 않고 똑같이 조합해야 함
    const serverSecret = process.env.SECRET_SALT;
    const rawString = Math.round(score) + serverSecret + userId;
    const expectedSignature = btoa(rawString); // Node.js v16+에서는 btoa 기본 지원

    if (signature !== expectedSignature) {
        console.warn(`🚨 [HACK DETECTED] Signature Mismatch! User: ${userId}`);
        return res.status(403).json({ error: "데이터 변조가 감지되었습니다." });
    }

    // 통과하면 다음 단계로
    next();
};

// ==========================================
// ★ 5. API 기능들
// ==========================================

// [기능 1] 점수 저장 (보안 미들웨어 `verifySignature` 장착!)
app.post("/api/score", verifySignature, async (req, res) => {
  const { userId, userName, song, diff, score, level } = req.body;

  try {
    // 몽고DB Injection 방지를 위한 타입 변환
    const cleanScore = Number(score);
    const cleanLevel = Number(level);

    if (isNaN(cleanScore) || cleanScore > 1000000) { // 100만점 초과 방지
        return res.status(400).json({ error: "유효하지 않은 점수입니다." });
    }

    await Score.updateOne(
      { userId, song, diff }, 
      { 
        $max: { score: cleanScore }, 
        $set: { userName: userName, level: cleanLevel || 1 } 
      },
      { upsert: true }
    );
    console.log(`[SCORE] ${userName} - ${song}: ${cleanScore} (Verified)`);
    res.json({ success: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: true });
    console.error(e);
    res.status(500).json({ error: "DB Error" });
  }
});

// [기능 2] 랭킹 조회
app.get("/api/ranking/:song/:diff", async (req, res) => {
  const { song, diff } = req.params;
  try {
    const leaderboard = await Score.find({ song, diff })
      .sort({ score: -1 })
      .limit(50)
      .select('userName score level -_id'); // 필요한 필드만 전송 (보안)
    res.json(leaderboard);
  } catch (e) {
    res.status(500).json([]);
  }
});

// [기능 3] 유저 정보 조회
app.get("/api/user/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    let user = await User.findOne({ userId });
    if (!user) user = { level: 1, xp: 0, nickname: null };
    res.json(user);
  } catch (e) {
    res.status(500).json({ level: 1, xp: 0, nickname: null });
  }
});

// [기능 4] 유저 정보 업데이트
app.post("/api/user/update", async (req, res) => {
  const { userId, level, xp, nickname } = req.body;
  
  try {
    const updateData = {};
    if (level !== undefined) updateData.level = Number(level);
    if (xp !== undefined) updateData.xp = Number(xp);
    if (nickname !== undefined) updateData.nickname = String(nickname).substring(0, 12); // 길이 제한

    await User.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { upsert: true, new: true }
    );

    if (nickname) {
        await Score.updateMany(
            { userId: userId },
            { $set: { userName: nickname } }
        );
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "DB Error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🛡️ Secure Server running on port ${port}`);
});