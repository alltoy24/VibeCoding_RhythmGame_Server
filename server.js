require("dotenv").config(); // Load .env file
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet"); // Security headers
const rateLimit = require("express-rate-limit"); // Anti-spam
const http = require("http");
const { Server } = require("socket.io");

// ==========================================
// ★ 0. Server Initialization
// ==========================================
const app = express();
const server = http.createServer(app);

// Socket.io Setup (Optimized for Stability)
const io = new Server(server, {
    cors: {
        origin: "*", // Production에서는 실제 도메인으로 변경 권장
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000, // 연결 유지 시간 늘림 (네트워크 불안정 대비)
    pingInterval: 25000
});

// Trust Proxy (For Heroku/Cloudtype)
app.set('trust proxy', 1);

// ==========================================
// ★ 1. Security Middleware Configuration
// ==========================================
app.use(helmet()); 
app.use(express.json({ limit: '10kb' })); // Body limit
app.use(cors());

// [Anti-Spam] API Rate Limiter
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15분
    max: 100, // IP당 100회 제한
    message: { error: "Too many requests. Please try again later." }
});
app.use("/api/", limiter);

// ==========================================
// ★ 2. MongoDB Connection
// ==========================================
mongoose.connect(process.env.MONGO_URI || "")
  .then(() => console.log("✅ MongoDB Connected Successfully! (SECURE MODE)"))
  .catch(err => console.error("🔥 DB Connection Failed:", err));

// ==========================================
// ★ 3. Data Models
// ==========================================
const scoreSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  song: String,
  diff: String,
  mode: { type: String, default: "standard" },
  score: Number,
  level: Number,
  judgment: {
    absoluteSync: Number,
    tpPerfect: Number,
    perfect: Number,
    good: Number,
    bad: Number,
    miss: Number,
    totalNotes: Number
  },
  timestamp: { type: Date, default: Date.now }
});
scoreSchema.index({ userId: 1, song: 1, diff: 1 }, { unique: true });
const Score = mongoose.model("Score", scoreSchema);

const userSchema = new mongoose.Schema({
  userId: String,
  nickname: String,
  level: Number,
  xp: Number,
  rating: { type: Number, default: 1000 },
  tier: { type: String, default: "Bronze" },
  matchCount: { type: Number, default: 0 },
  winCount: { type: Number, default: 0 }
});
const User = mongoose.model("User", userSchema);

// ==========================================
// ★ 4. Security Verification
// ==========================================
const JUDGMENT_KEYS = ["absoluteSync", "tpPerfect", "perfect", "good", "bad", "miss"];
const PRECISION_WEIGHTS = { absoluteSync: 1.0, tpPerfect: 0.90, perfect: 0.80, good: 0.60, bad: 0.40, miss: 0 };

function isPrecisionEligibleDiff(diff) {
  // Normal/Hard는 일반 점수 전용이다. Troll 및 특수 난이도만 동기화 연주를 허용한다.
  const chartKey = String(diff || "").replace(/__precision$/i, "");
  return !/^(?:normal|hard)(?:_|$)/i.test(chartKey);
}

function validateJudgmentPayload(body) {
  const details = body && body.details;
  const totalNotes = Number(body && body.totalNotes);
  const requestedMode = body ? body.mode : undefined;
  const mode = requestedMode === undefined ? "standard" : String(requestedMode);
  if (mode !== "standard" && mode !== "precision") {
    return { error: "Invalid score mode" };
  }
  if (mode === "precision" && !isPrecisionEligibleDiff(body && body.diff)) {
    return { error: "Precision mode is only available for Troll and special charts" };
  }
  if (!details || typeof details !== "object" || !Number.isInteger(totalNotes) || totalNotes <= 0) {
    return { error: "Judgment details are required" };
  }

  const stats = {};
  for (const key of JUDGMENT_KEYS) {
    // 기존 일반 모드 클라이언트에는 absoluteSync 필드가 없으므로 0으로 호환한다.
    const value = key === "absoluteSync" && details[key] === undefined ? 0 : Number(details[key]);
    if (!Number.isInteger(value) || value < 0) {
      return { error: `Invalid judgment count: ${key}` };
    }
    stats[key] = value;
  }

  const judgedNotes = JUDGMENT_KEYS.reduce((sum, key) => sum + stats[key], 0);
  if (judgedNotes !== totalNotes) {
    return { error: "Judgment count does not match total notes" };
  }
  if (mode === "standard" && stats.absoluteSync !== 0) {
    return { error: "ABSOLUTE SYNC judgments require precision mode" };
  }

  const weights = mode === "precision"
    ? PRECISION_WEIGHTS
    : { absoluteSync: 0, tpPerfect: 1.0, perfect: 1.0, good: 0.70, bad: 0.30, miss: 0 };
  const expectedScore = Math.floor((1000000 * JUDGMENT_KEYS.reduce(
    (sum, key) => sum + (stats[key] * weights[key]), 0
  )) / totalNotes);
  const suppliedScore = Number(body.score);
  const maxCombo = Number(body.maxCombo || 0);
  if (!Number.isInteger(suppliedScore) || suppliedScore !== expectedScore) {
    return { error: "Score does not match judgments" };
  }
  if (!Number.isInteger(maxCombo) || maxCombo < 0 || maxCombo > totalNotes) {
    return { error: "Invalid max combo" };
  }

  return { stats, totalNotes, expectedScore, maxCombo, mode };
}

function verifySignature(req, res, next) {
  const { userId, score, maxCombo, signature } = req.body;
  const SECRET_SALT = process.env.SECRET_SALT || "WebBeat_Secure_Key_2026_Ver42";

  if (!signature) {
    return res.status(403).json({ success: false, error: "Security Token Missing" });
  }

  try {
    const judgment = validateJudgmentPayload(req.body);
    if (judgment.error) {
      return res.status(400).json({ success: false, error: judgment.error });
    }

    // 1. 모든 인입 데이터를 정수형 및 문자열 표준 타입으로 강제 변환 (타입 오차 원천 차단)
    const secureUserId = String(userId);
    const secureScore = judgment.expectedScore;
    const secureMaxCombo = judgment.maxCombo;
    const judgeSignature = [
      judgment.stats.absoluteSync,
      judgment.stats.tpPerfect,
      judgment.stats.perfect,
      judgment.stats.good,
      judgment.stats.bad,
      judgment.stats.miss,
      judgment.totalNotes
    ].join(':');

    // 새 형식과 이미 배포된 클라이언트의 기본 형식을 함께 허용한다.
    // 어느 경우든 아래 판정 통계/점수 재계산 검증은 반드시 통과해야 한다.
    const rawSignature = `${secureUserId}_${secureScore}_${secureMaxCombo}_${judgeSignature}_${SECRET_SALT}`;
    const precisionRawSignature = `${secureUserId}_${secureScore}_${secureMaxCombo}_${judgment.mode}_${judgeSignature}_${SECRET_SALT}`;
    const legacyRawSignature = `${secureUserId}_${secureScore}_${secureMaxCombo}_${SECRET_SALT}`;
    const expectedSignature = Buffer.from(rawSignature, 'utf8').toString('base64');
    const precisionExpectedSignature = Buffer.from(precisionRawSignature, 'utf8').toString('base64');
    const legacyExpectedSignature = Buffer.from(legacyRawSignature, 'utf8').toString('base64');

    const signatureValid = judgment.mode === "precision"
      ? signature === precisionExpectedSignature
      : signature === expectedSignature || signature === legacyExpectedSignature;
    if (!signatureValid) {
      console.warn("🚨 [Signature Mismatch] 서명이 일치하지 않습니다!");
      return res.status(403).json({ success: false, error: "Data Tampering Detected (Signature Mismatch)" });
    }

    // 검증 성공 시 다음 로직 진행
    req.verifiedScore = judgment.expectedScore;
    req.verifiedJudgments = judgment;
    next();
  } catch (err) {
    console.error("🚨 서버 서명 검증 중 크리티컬 에러:", err);
    return res.status(403).json({ success: false, error: "Security Token Validation Failed" });
  }
}

// ==========================================
// ★ 5. Multiplayer Logic (Refactored)
// ==========================================

let rooms = {}; 
let roomSeq = 1; 

const SONG_DB = [
  {
    "folder": "NewEra",
    "title": "New Era",
    "artist": "Alltoy24",
    "charts": ["normal_4.json", "hard_8.json","troll_11.json"]
  },
  {
    "folder": "세계수의정원",
    "title": "세계수의 정원",
    "artist": "Alltoy24",
    "charts": ["normal_1.json", "hard_6.json", "troll_13.json"]
  },
  {
    "folder": "SystemOverload",
    "title": "System Overload",
    "artist": "Alltoy24",
    "charts": ["normal_5.json", "troll_16.json"]
  },
  {
    "folder": "SuddenAccelerationOfEmpty",
    "title": "Sudden Acceleration Of Empty",
    "artist": "Alltoy24",
    "charts": ["hard_14.json", "troll_17.json"]
  },
  {
    "folder": "BreakGlassDayDream",
    "title": "Break Glass Daydream",
    "artist": "Alltoy24",
    "charts": ["troll_15.json"]
  },
  {
    "folder": "Cataclysm",
    "title": "Cataclysm",
    "artist": "Alltoy24",
    "charts": ["troll_18.json"]
  },
  {
    "folder": "Checkpoint1",
    "title": "Checkpoint:1",
    "artist": "Alltoy24",
    "charts": ["hard_6.json"]
  },
  {
    "folder": "PuzzleVIP",
    "title": "Puzzle VIP",
    "artist": "RetroVision",
    "charts": ["troll_15.json"]
  },
  {
    "folder": "SATELLITE",
    "title": "SATELLITE",
    "artist": "NOMA",
    "charts": ["hard_10.json"]
  }
]

function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id,
        title: r.title,
        host: r.hostName,
        status: r.status,
        pCount: r.players.filter(p => p.connected).length // 연결된 사람 수만 표시
    }));
}

async function startGameSequence(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.status = "PLAYING";
    room.isTransitioning = true; // ★ [추가] "지금 페이지 이동 중임" 표시

    // ★ [추가] 15초 뒤에는 이동이 끝났을 테니 플래그 해제
    setTimeout(() => { 
        if(rooms[roomId]) rooms[roomId].isTransitioning = false; 
    }, 15000);
    
    // 랜덤 곡 선정
    const randomSong = SONG_DB[Math.floor(Math.random() * SONG_DB.length)];
    const randomChart = randomSong.charts[Math.floor(Math.random() * randomSong.charts.length)];
    const diffKey = randomChart.replace(".json", ""); 

    console.log(`🚀 Game Start: Room ${roomId} | ${randomSong.title} [${diffKey}]`);

    // Delay: 3s(Intro) + 3s(Reveal) + 15s(Countdown) = 21s
    const startTime = Date.now() + 21000;

    // ★ [핵심] 플레이어들의 RP 정보 가져오기
    // (메모리에 없으므로 DB에서 가져와야 함)
    // room.players[0]과 [1]의 닉네임으로 DB 조회
    let p1_RP = 1000;
    let p2_RP = 1000;

    try {
        const p1_Data = await User.findOne({ nickname: room.players[0].nickname });
        const p2_Data = await User.findOne({ nickname: room.players[1].nickname });
        if (p1_Data) p1_RP = p1_Data.rating || 1000;
        if (p2_Data) p2_RP = p2_Data.rating || 1000;
    } catch (e) {
        console.error("RP Fetch Error:", e);
    }

    // ★ [핵심] 각 플레이어에게 "상대방의 RP"를 담아서 개별 전송
    // Player 1에게는 Player 2의 RP를 보냄
    io.to(room.players[0].socketId).emit("game_start", {
        songFolder: randomSong.folder,
        songTitle: randomSong.title,
        songArtist: randomSong.artist,
        diffKey: diffKey,
        startTime: startTime,
        opponentRP: p2_RP // P1의 상대는 P2
    });

    // Player 2에게는 Player 1의 RP를 보냄
    io.to(room.players[1].socketId).emit("game_start", {
        songFolder: randomSong.folder,
        songTitle: randomSong.title,
        songArtist: randomSong.artist,
        diffKey: diffKey,
        startTime: startTime,
        opponentRP: p1_RP // P2의 상대는 P1
    });

    io.emit("update_room_list", getRoomList());
}

// Garbage Collector: 30초마다 빈 방이나 오랫동안 유령 상태인 방 정리
setInterval(() => {
    for (const rId in rooms) {
        const room = rooms[rId];
        // 플레이어가 없거나 모든 플레이어가 연결이 끊긴 지 오래된 경우
        const activePlayers = room.players.filter(p => p.connected);
        if (activePlayers.length === 0) {
            delete rooms[rId];
            console.log(`🧹 Garbage Collector: Deleted Empty Room ${rId}`);
            io.emit("update_room_list", getRoomList());
        }
    }
}, 30000);

io.on("connection", (socket) => {
    // console.log(`🔌 Connected: ${socket.id}`);

    // [Lobby] Request List
    socket.on("request_room_list", () => {
        socket.emit("update_room_list", getRoomList());
    });

    // [Lobby] Create Room (★ 수정: 방장 RP 조회 및 저장)
    socket.on("create_room", async (data) => {
        const roomId = `room_${roomSeq++}`;
        
        let userRating = 1000;
        try {
            // 방장의 점수를 DB에서 가져옴
            const userDoc = await User.findOne({ nickname: data.nickname });
            if (userDoc) userRating = userDoc.rating;
        } catch(e) { console.error(e); }

        rooms[roomId] = {
            id: roomId,
            title: data.title,
            hostId: socket.id,
            hostName: data.nickname,
            players: [{ 
                socketId: socket.id, 
                nickname: data.nickname, 
                rating: userRating, // ★ 방장의 RP 저장
                ready: true, 
                connected: true 
            }],
            status: "WAITING"
        };

        socket.join(roomId);
        socket.emit("room_joined", { roomId, roomData: rooms[roomId], isHost: true });
        io.emit("update_room_list", getRoomList());
        console.log(`🏠 Created: ${data.title} (${roomId}) - Host RP: ${userRating}`);
    });

    // 서버 코드의 game_over 내부 수정 예시
    socket.on("game_over", async (data) => {
        const { roomId, finishType, finalScore } = data; // 클라이언트가 최종 점수도 보내도록 변경
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
            player.finished = true;
            player.finalScore = finalScore || 0; // 점수 기록
        }

        const allFinished = room.players.every(p => p.finished === true || p.connected === false);

        if (allFinished) {
            // 2인 플레이어이고 모두 정상 종료했을 때 승패 및 RP 계산
            const p1 = room.players[0];
            const p2 = room.players[1];

            if (p1 && p2 && p1.connected && p2.connected) {
                let p1_Win = p1.finalScore > p2.finalScore ? 1 : (p1.finalScore < p2.finalScore ? 0 : 0.5);
                
                // 간단한 Elo 계산 예시 (K-Factor = 32)
                const E1 = 1 / (1 + Math.pow(10, (p2.rating - p1.rating) / 400));
                const E2 = 1 / (1 + Math.pow(10, (p1.rating - p2.rating) / 400));
                
                const p1_NewRating = Math.round(p1.rating + 32 * (p1_Win - E1));
                const p2_NewRating = Math.round(p2.rating + 32 * ((1 - p1_Win) - E2));

                // DB 업데이트
                try {
                    await User.updateOne({ nickname: p1.nickname }, { $set: { rating: p1_NewRating }, $inc: { matchCount: 1, winCount: p1_Win === 1 ? 1 : 0 } });
                    await User.updateOne({ nickname: p2.nickname }, { $set: { rating: p2_NewRating }, $inc: { matchCount: 1, winCount: p1_Win === 0 ? 1 : 0 } });
                    
                    // 양쪽 클라이언트에 매치 결과 전송
                    io.to(roomId).emit("match_result", {
                        results: [
                            { nickname: p1.nickname, score: p1.finalScore, oldRp: p1.rating, newRp: p1_NewRating },
                            { nickname: p2.nickname, score: p2.finalScore, oldRp: p2.rating, newRp: p2_NewRating }
                        ]
                    });
                } catch (e) { console.error("RP Update Error:", e); }
            }

            delete rooms[roomId];
            io.emit("update_room_list", getRoomList());
        }
    });

    socket.on("join_room", async (data) => {
        const { roomId, nickname } = data;
        const room = rooms[roomId];

        if (!room) {
            socket.emit("error_msg", "Room does not exist.");
            return;
        }

        // 1. 재접속 확인 (게임 중 튕겼을 때)
        const existingPlayer = room.players.find(p => p.nickname === nickname);
        if (existingPlayer) {
            console.log(`🔄 Reconnect: ${nickname} -> ${roomId}`);
            existingPlayer.socketId = socket.id;
            existingPlayer.connected = true;
            socket.join(roomId);
            
            socket.emit("room_joined", { 
                roomId, roomData: room, isHost: (room.hostName === nickname) 
            });
            return;
        }

        // 2. 인원 확인
        if (room.players.length >= 2) {
            socket.emit("error_msg", "Room is full.");
            return;
        }

        // 3. ★ DB에서 참가자 RP 조회
        let userRating = data.rp || 1000;
        if (!data.rp) {
            try {
                const userDoc = await User.findOne({ nickname: nickname });
                if (userDoc) userRating = userDoc.rating;
            } catch(e) { console.error(e); }
        }

        // 4. 참가 처리
        room.players.push({ 
            socketId: socket.id, 
            nickname: nickname, 
            rating: userRating, // ★ 참가자 점수 저장
            ready: true, 
            connected: true 
        });
        socket.join(roomId);

        // 참가자 본인에게 전송
        socket.emit("room_joined", { roomId, roomData: room, isHost: false });
        
        // ★ 방장에게 "새 유저(점수 포함) 들어옴" 알림
        socket.to(roomId).emit("player_entered", { 
            nickname: nickname,
            rating: userRating 
        });

        io.emit("update_room_list", getRoomList());
        console.log(`🏃 Joined: ${nickname} (${userRating} RP) -> ${roomId}`);

        // 2명 다 차면 게임 시작
        if (room.players.length === 2) {
            startGameSequence(roomId);
        }
    });

    socket.on("quick_match", async (data) => {
        // 대기 중이고 1명만 있는 방 찾기
        const availableRoom = Object.values(rooms).find(r => r.status === "WAITING" && r.players.length < 2);

        if (availableRoom) {
            socket.emit("quick_match_found", availableRoom.id);
        } else {
            // 방이 없으면 생성 (여기도 RP 조회 추가)
            const roomId = `room_${roomSeq++}`;
            
            // ★ [수정] 받은 rp 우선 사용
            let userRating = data.rp || 1000;
            
            if (!data.rp) {
                try {
                    const userDoc = await User.findOne({ nickname: data.nickname });
                    if (userDoc) userRating = userDoc.rating;
                } catch(e) {}
            }

            rooms[roomId] = {
                id: roomId,
                title: `${data.nickname}'s Match`,
                hostId: socket.id,
                hostName: data.nickname,
                players: [{ 
                    socketId: socket.id, 
                    nickname: data.nickname, 
                    rating: userRating, // ★ RP 저장
                    ready: true, 
                    connected: true 
                }],
                status: "WAITING"
            };
            socket.join(roomId);
            socket.emit("room_joined", { roomId, roomData: rooms[roomId], isHost: true });
            io.emit("update_room_list", getRoomList());
        }
    });

    // [Game] Score Sync
    socket.on("send_score", (data) => {
        // data: { roomId, score, combo, lane }
        socket.to(data.roomId).emit("opponent_update", data);
    });

    // [연결 해제 핸들러]
    const handleLeave = () => {
        for (const rId in rooms) {
            const room = rooms[rId];
            const player = room.players.find(p => p.socketId === socket.id);
            
            if (player) {
                if (room.status === "PLAYING") {
                    // ★ [수정] 페이지 이동 중(Transitioning)이라면 '상대 나감' 알림을 보내지 않음!
                    if (room.isTransitioning) {
                        console.log(`⚠️ Page Transition Disconnect (Ignored): ${player.nickname}`);
                        player.connected = false; // 연결 상태만 false로 하고 방은 유지
                    } else {
                        // 실제 게임 도중 탈주한 경우
                        player.connected = false; 
                        player.finished = true; 
                        io.to(rId).emit("opponent_left"); 

                        const allDone = room.players.every(p => p.finished === true || p.connected === false);
                        if (allDone) delete rooms[rId];
                    }
                } else {
                    // 대기 중 탈주 (기존 코드 그대로)
                    room.players = room.players.filter(p => p.socketId !== socket.id);
                    socket.leave(rId);
                    if (room.players.length === 0) delete rooms[rId];
                    else io.to(rId).emit("opponent_left");
                    
                    io.emit("update_room_list", getRoomList());
                }
                break;
            }
        }
    };

    socket.on("leave_room", handleLeave);
    socket.on("disconnect", handleLeave);
});

// ==========================================
// ★ 6. API Endpoints
// ==========================================

// [API 1] Save Score
app.post("/api/score", verifySignature, async (req, res) => {
  const { userId, userName, song, diff, level } = req.body;
  try {
    const cleanScore = req.verifiedScore;
    const verified = req.verifiedJudgments;
    if (!Number.isInteger(cleanScore) || cleanScore < 0 || cleanScore > 1000000 || !verified) {
      return res.status(400).json({ error: "Invalid Score" });
    }

    await Score.updateOne(
      { userId, song, diff }, 
      {
        $max: { score: cleanScore },
        $set: {
          userName: userName,
          level: Number(level) || 1,
          mode: verified.mode,
          judgment: { ...verified.stats, totalNotes: verified.totalNotes }
        }
      },
      { upsert: true }
    );
    console.log(`[SCORE] ${userName}: ${cleanScore} (${verified.mode})`);
    res.json({ success: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: true });
    res.status(500).json({ error: "DB Error" });
  }
});

// [API 2] Ranking
app.get("/api/ranking/:song/:diff", async (req, res) => {
  try {
    const leaderboard = await Score.find({ song: req.params.song, diff: req.params.diff })
      .sort({ score: -1 }).limit(50).select('userName score level -_id'); 
    res.json(leaderboard);
  } catch (e) { res.status(500).json([]); }
});

// [API 3] User Info
app.get("/api/user/:userId", async (req, res) => {
  try {
    let user = await User.findOne({ userId: req.params.userId });
    if (!user) user = { level: 1, xp: 0, nickname: null };
    res.json(user);
  } catch (e) { res.status(500).json({ level: 1, xp: 0, nickname: null }); }
});

// [API 4] Update User
app.post("/api/user/update", async (req, res) => {
  const { userId, level, xp, nickname } = req.body;
  try {
    const updateData = {};
    if (level !== undefined) updateData.level = Number(level);
    if (xp !== undefined) updateData.xp = Number(xp);
    if (nickname !== undefined) updateData.nickname = String(nickname).substring(0, 12); 

    await User.findOneAndUpdate({ userId }, { $set: updateData }, { upsert: true, new: true });
    if (nickname) await Score.updateMany({ userId }, { $set: { userName: nickname } });
    
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "DB Error" }); }
});

// ==========================================
// ★ Start Server
// ==========================================
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`🛡️ Secure Server & Socket.io running on port ${port}`);
});
