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
  score: Number,
  level: Number,
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
// ★ 4. Security Verification (Core Logic)
// ==========================================
const verifySignature = (req, res, next) => {
    const { userId, score, maxCombo, signature, playTime } = req.body;
    
    if (!userId || score === undefined || maxCombo === undefined || !signature) {
        return res.status(400).json({ error: "Invalid Request (Missing Data)" });
    }

    // Anti-Cheat: Playtime check
    if (playTime && playTime < 10000) {
        console.warn(`🚨 [HACK] Short PlayTime: ${playTime}ms (${userId})`);
        return res.status(403).json({ error: "Abnormal play detected" });
    }

    // Signature Verification
    const serverSecret = process.env.SECRET_SALT || "WebBeat_Secure_Key_2026_Ver42"; 
    const rawString = `${userId}_${score}_${maxCombo}_${serverSecret}`;
    const expectedSignature = Buffer.from(rawString).toString('base64');

    if (signature !== expectedSignature) {
        console.log("🚨 [Signature Mismatch] Hack Suspected!");
        return res.status(403).json({ error: "Data Tampering Detected" });
    }

    next();
};

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

    socket.on("game_over", (data) => {
        const { roomId, finishType } = data;
        const room = rooms[roomId];
        if (!room) return;

        // 상대방에게 결과 알림
        socket.to(roomId).emit("opponent_finished", { finishType });

        // 내 상태 '완료'로 변경
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
            player.finished = true;
            console.log(`🏁 Finished: ${player.nickname}`);
        }

        // ★ [핵심] 방 폭파 조건 수정
        // 조건: (게임 끝난 사람) OR (탈주해서 연결 끊긴 사람)
        const allFinished = room.players.every(p => p.finished === true || p.connected === false);

        if (allFinished) {
            delete rooms[roomId]; // 방 삭제 💥
            console.log(`💥 Room Closed (All Done): ${roomId}`);
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
  const { userId, userName, song, diff, score, level } = req.body;
  try {
    const cleanScore = Number(score);
    if (isNaN(cleanScore) || cleanScore > 1000000) return res.status(400).json({ error: "Invalid Score" });

    await Score.updateOne(
      { userId, song, diff }, 
      { $max: { score: cleanScore }, $set: { userName: userName, level: Number(level) || 1 } },
      { upsert: true }
    );
    console.log(`[SCORE] ${userName}: ${cleanScore}`);
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