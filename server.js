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

// Song Database
const SONG_DB = [
    { folder: "NewEra", title: "New Era", artist: "Alltoy24", charts: ["normal_4.json", "hard_8.json", "troll_11.json"] },
    { folder: "세계수의정원", title: "Garden of Yggdrasil", artist: "Alltoy24", charts: ["normal_1.json", "hard_6.json", "troll_13.json"] },
    { folder: "Test", title: "Test Map", artist: "Alltoy24", charts: ["normal_2.json"] }
];

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

    // [Lobby] Create Room
    socket.on("create_room", (data) => {
        const roomId = `room_${roomSeq++}`;
        rooms[roomId] = {
            id: roomId,
            title: data.title,
            hostId: socket.id,
            hostName: data.nickname,
            players: [{ 
                socketId: socket.id, 
                nickname: data.nickname, 
                ready: true, 
                connected: true 
            }],
            status: "WAITING"
        };

        socket.join(roomId);
        socket.emit("room_joined", { roomId, roomData: rooms[roomId], isHost: true });
        io.emit("update_room_list", getRoomList());
        console.log(`🏠 Created: ${data.title} (${roomId})`);
    });

    // [★ 추가] 게임 종료 신호 처리 & 방 삭제 로직
    socket.on("game_over", (data) => {
        const { roomId, finishType } = data; // finishType 받기
        const room = rooms[roomId];
        if (!room) return;

        // ★ 상대방에게 "쟤 끝났대! (그리고 풀콤보래!)" 라고 알려줌
        socket.to(roomId).emit("opponent_finished", { 
            finishType: finishType 
        });

        // 해당 플레이어 '완료' 상태로 변경
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
            player.finished = true;
            console.log(`🏁 Player Finished: ${player.nickname} in ${roomId}`);
        }

        // 방에 있는 '모든' 플레이어가 finished 상태인지 확인
        // (주의: 플레이어가 나갔을 수도 있으니 현재 남아있는 사람 기준으로 체크)
        const allFinished = room.players.every(p => p.finished === true);

        if (allFinished) {
            delete rooms[roomId]; // 방 폭파 💥
            console.log(`💥 All players finished. Room Destroyed: ${roomId}`);
            
            // 로비에 있는 사람들에게 방 목록 갱신 요청
            io.emit("update_room_list", getRoomList());
        }
    });

    // [Lobby] Join Room (★ RECONNECTION LOGIC ADDED)
    socket.on("join_room", (data) => {
        const { roomId, nickname } = data;
        const room = rooms[roomId];

        if (!room) {
            socket.emit("error_msg", "Room does not exist.");
            return;
        }

        // 1. 재접속 확인 (닉네임 일치 & 게임 중)
        const existingPlayer = room.players.find(p => p.nickname === nickname);
        
        if (existingPlayer) {
            // 게임 중이거나, 잠시 튕겼다가 돌아온 경우
            console.log(`🔄 Reconnect: ${nickname} -> ${roomId}`);
            
            // 소켓 ID 갱신 및 상태 복구
            existingPlayer.socketId = socket.id;
            existingPlayer.connected = true;
            socket.join(roomId);

            // 재접속한 유저에게 현재 방 정보 전송
            socket.emit("room_joined", { 
                roomId, 
                roomData: room, 
                isHost: (room.hostName === nickname) 
            });
            
            // 방에 게임이 진행 중이라면 상대방에게 "상대 재접속함" 알림 가능 (선택 사항)
            return; 
        }

        // 2. 신규 입장 제한
        if (room.players.length >= 2) {
            socket.emit("error_msg", "Room is full.");
            return;
        }

        // 3. 신규 입장 처리
        room.players.push({ 
            socketId: socket.id, 
            nickname: nickname, 
            ready: true, 
            connected: true 
        });
        socket.join(roomId);

        // Notify Joiner
        socket.emit("room_joined", { roomId, roomData: room, isHost: false });
        // Notify Host
        socket.to(roomId).emit("player_entered", { nickname: nickname });

        io.emit("update_room_list", getRoomList());
        console.log(`🏃 Joined: ${nickname} -> ${roomId}`);

        // Auto Start
        if (room.players.length === 2) {
            startGameSequence(roomId);
        }
    });

    // [Lobby] Quick Match
    socket.on("quick_match", (data) => {
        // 대기 중이고 1명만 있는 방 찾기
        const availableRoom = Object.values(rooms).find(r => r.status === "WAITING" && r.players.length < 2);

        if (availableRoom) {
            socket.emit("quick_match_found", availableRoom.id);
        } else {
            // 방이 없으면 생성
            const roomId = `room_${roomSeq++}`;
            rooms[roomId] = {
                id: roomId,
                title: `${data.nickname}'s Match`,
                hostId: socket.id,
                hostName: data.nickname,
                players: [{ 
                    socketId: socket.id, 
                    nickname: data.nickname, 
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

    // [Game] Leave / Disconnect Handler
    const handleLeave = () => {
        for (const rId in rooms) {
            const room = rooms[rId];
            const player = room.players.find(p => p.socketId === socket.id);
            
            if (player) {
                // ★ 핵심: 게임 중(PLAYING)이면 방을 폭파하지 않고 'connected: false'로만 표시
                // 페이지 이동(새로고침) 시 재접속을 위해 데이터를 유지함.
                if (room.status === "PLAYING") {
                    console.log(`⚠️ Disconnect during game (Pending Reconnect): ${player.nickname}`);
                    player.connected = false; 
                    // 1분 뒤에도 안 돌아오면 그때 진짜 삭제 로직은 Garbage Collector가 담당
                    return; 
                }

                // 대기실(WAITING) 상태라면 즉시 퇴장 처리
                room.players = room.players.filter(p => p.socketId !== socket.id);
                socket.leave(rId);

                if (room.players.length === 0) {
                    delete rooms[rId];
                    console.log(`🗑️ Room Deleted: ${rId}`);
                } else {
                    room.status = "WAITING";
                    io.to(rId).emit("opponent_left"); // 상대 나감 알림
                    console.log(`👋 Left: ${player.nickname}`);
                }
                
                io.emit("update_room_list", getRoomList());
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