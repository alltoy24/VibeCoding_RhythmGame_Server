require("dotenv").config(); // .env 파일 로드
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet"); // 보안 헤더 설정
const rateLimit = require("express-rate-limit"); // 도배 방지

const app = express();

// ★ [필수] 프록시 신뢰 설정 (Cloudtype/Heroku 등 배포 시 필수)
app.set('trust proxy', 1);

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
  xp: Number,
  // ★ 추가
  rating: { type: Number, default: 1000 }, // 기본 점수 1000점
  tier: { type: String, default: "Bronze" },
  matchCount: { type: Number, default: 0 },
  winCount: { type: Number, default: 0 }
});
const User = mongoose.model("User", userSchema);

// ==========================================
// ★ 4. 보안 검증 함수 (핵심!)
// ==========================================
const verifySignature = (req, res, next) => {
    // 1. 클라이언트가 보낸 데이터 받기 (maxCombo 꼭 받아야 함!)
    const { userId, score, maxCombo, signature, playTime } = req.body;
    
    // 2. 필수 데이터 누락 확인
    if (!userId || score === undefined || maxCombo === undefined || !signature) {
        console.log("❌ 데이터 누락:", { userId, score, maxCombo, signature });
        return res.status(400).json({ error: "잘못된 요청입니다. (필수 데이터 누락)" });
    }

    // 3. 플레이 타임 검증 (그대로 유지)
    if (playTime && playTime < 10000) {
        console.warn(`🚨 [HACK] PlayTime too short: ${playTime}ms (${userId})`);
        return res.status(403).json({ error: "비정상적인 플레이 감지됨" });
    }

    // 4. ★★★ [핵심 수정] 서명 검증 로직 일치시키기 ★★★
    // 클라이언트의 로직: `${userId}_${score}_${maxCombo}_${SECRET_SALT}`
    // 서버도 똑같이 만들어야 함!
    const serverSecret = process.env.SECRET_SALT || "WebBeat_Secure_Key_2026_Ver42"; // 클라이언트와 키가 같아야 함!
    
    // 순서: 아이디_점수_콤보_비밀키 (언더바 필수)
    const rawString = `${userId}_${score}_${maxCombo}_${serverSecret}`;
    
    // Base64 인코딩 (Node.js 방식)
    const expectedSignature = Buffer.from(rawString).toString('base64');

    // 5. 비교 (로그 찍어서 확인)
    if (signature !== expectedSignature) {
        console.log("---------------------------------------");
        console.log("🚨 [서명 불일치] 해킹 의심!");
        console.log("📥 클라이언트가 보낸 것:", signature);
        console.log("💻 서버가 계산한 것:    ", expectedSignature);
        console.log("🔑 서버 원본 문자열:    ", rawString); // 이게 클라이언트랑 같은지 확인 필요
        console.log("---------------------------------------");
        return res.status(403).json({ error: "데이터 변조가 감지되었습니다." });
    }

    // 통과!
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