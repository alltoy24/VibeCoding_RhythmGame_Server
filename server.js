require("dotenv").config(); // .env 파일 로드
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet"); // 보안 헤더 설정
const rateLimit = require("express-rate-limit"); // 도배 방지
// ★ [추가] 웹소켓을 위한 모듈 로드
const http = require("http");
const { Server } = require("socket.io");

const app = express();

// ★ [추가] Express 앱을 HTTP 서버로 감싸기 (Socket.io 연동 필수)
const server = http.createServer(app);

// ★ [추가] Socket.io 설정 (CORS 허용)
const io = new Server(server, {
    cors: {
        origin: "*", // 실제 배포 시엔 클라이언트 주소로 제한하는 것이 보안상 좋습니다.
        methods: ["GET", "POST"]
    }
});

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
  // ★ 추가된 필드 유지
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

    // 4. 서명 검증 로직
    const serverSecret = process.env.SECRET_SALT || "WebBeat_Secure_Key_2026_Ver42"; 
    const rawString = `${userId}_${score}_${maxCombo}_${serverSecret}`;
    const expectedSignature = Buffer.from(rawString).toString('base64');

    // 5. 비교
    if (signature !== expectedSignature) {
        console.log("---------------------------------------");
        console.log("🚨 [서명 불일치] 해킹 의심!");
        return res.status(403).json({ error: "데이터 변조가 감지되었습니다." });
    }

    // 통과!
    next();
};

// ==========================================
// ★ 5. [신규] 멀티플레이 소켓 로직
// ==========================================
let waitingQueue = []; // 매칭 대기열

io.on("connection", (socket) => {
    console.log(`🔌 [Socket] 유저 접속: ${socket.id}`);

    // [매칭 요청]
    socket.on("join_match", (userData) => {
        // 이미 대기열에 있는지 확인
        const existing = waitingQueue.find(u => u.socketId === socket.id);
        if (existing) return;

        console.log(`⚔️ 매칭 대기: ${userData.nickname} (${socket.id})`);
        waitingQueue.push({ socketId: socket.id, ...userData });

        // 2명 이상이면 매칭 성사
        if (waitingQueue.length >= 2) {
            const p1 = waitingQueue.shift();
            const p2 = waitingQueue.shift();
            const roomId = `room_${p1.socketId}_${p2.socketId}`;

            io.to(p1.socketId).socketsJoin(roomId);
            io.to(p2.socketId).socketsJoin(roomId);

            const startTime = Date.now() + 4000; // 4초 뒤 시작

            io.to(roomId).emit("match_found", {
                roomId: roomId,
                players: [p1, p2],
                startTime: startTime
            });
            console.log(`✅ 매칭 성공! 방: ${roomId}`);
        }
    });

    // [점수 동기화] 내 점수를 상대방에게 보냄
    socket.on("send_score", (data) => {
        // data: { roomId, score, combo, hp }
        socket.to(data.roomId).emit("opponent_update", data);
    });

    // [접속 해제]
    socket.on("disconnect", () => {
        console.log(`❌ [Socket] 접속 해제: ${socket.id}`);
        waitingQueue = waitingQueue.filter(u => u.socketId !== socket.id);
    });
});


// ==========================================
// ★ 6. API 기능들 (기존 유지)
// ==========================================

// [기능 1] 점수 저장
app.post("/api/score", verifySignature, async (req, res) => {
  const { userId, userName, song, diff, score, level } = req.body;

  try {
    const cleanScore = Number(score);
    const cleanLevel = Number(level);

    if (isNaN(cleanScore) || cleanScore > 1000000) { 
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
      .select('userName score level -_id'); 
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
    if (nickname !== undefined) updateData.nickname = String(nickname).substring(0, 12); 

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

// ==========================================
// ★ 서버 시작 (app.listen -> server.listen 변경)
// ==========================================
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`🛡️ Secure Server & Socket.io running on port ${port}`);
});