require("dotenv").config(); // .env 파일 로드
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet"); // 보안 헤더 설정
const rateLimit = require("express-rate-limit"); // 도배 방지
const http = require("http");
const { Server } = require("socket.io");

const app = express();

// Express 앱을 HTTP 서버로 감싸기 (Socket.io 연동 필수)
const server = http.createServer(app);

// Socket.io 설정
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// 프록시 신뢰 설정
app.set('trust proxy', 1);

// ==========================================
// ★ 1. 보안 미들웨어 설정
// ==========================================
app.use(helmet()); 
app.use(express.json({ limit: '10kb' })); 
app.use(cors());

// 도배 방지
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: "요청이 너무 많습니다." }
});
app.use("/api/", limiter);

// ==========================================
// ★ 2. MongoDB 연결
// ==========================================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("🔥 DB Error:", err));

// ==========================================
// ★ 3. 데이터 모델 (기존 유지)
// ==========================================
const scoreSchema = new mongoose.Schema({
  userId: String, userName: String, song: String, diff: String,
  score: Number, level: Number, timestamp: { type: Date, default: Date.now }
});
scoreSchema.index({ userId: 1, song: 1, diff: 1 }, { unique: true });
const Score = mongoose.model("Score", scoreSchema);

const userSchema = new mongoose.Schema({
  userId: String, nickname: String, level: Number, xp: Number,
  rating: { type: Number, default: 1000 },
  tier: { type: String, default: "Bronze" },
  matchCount: { type: Number, default: 0 },
  winCount: { type: Number, default: 0 }
});
const User = mongoose.model("User", userSchema);

// ==========================================
// ★ 4. 보안 검증 함수 (기존 유지)
// ==========================================
const verifySignature = (req, res, next) => {
    const { userId, score, maxCombo, signature, playTime } = req.body;
    
    if (!userId || score === undefined || maxCombo === undefined || !signature) {
        return res.status(400).json({ error: "데이터 누락" });
    }
    if (playTime && playTime < 10000) {
        return res.status(403).json({ error: "비정상 플레이" });
    }

    const serverSecret = process.env.SECRET_SALT || "WebBeat_Secure_Key_2026_Ver42"; 
    const rawString = `${userId}_${score}_${maxCombo}_${serverSecret}`;
    const expectedSignature = Buffer.from(rawString).toString('base64');

    if (signature !== expectedSignature) {
        return res.status(403).json({ error: "데이터 변조 감지" });
    }
    next();
};

// ==========================================
// ★ 5. [멀티플레이 로직] (여기가 추가된 부분)
// ==========================================
let rooms = {}; 
let roomSeq = 1; 

// 곡 데이터베이스 (song_list.json 내용)
const SONG_DB = [
    { folder: "NewEra", title: "New Era", artist: "Alltoy24", charts: ["normal_4.json", "hard_8.json", "troll_11.json"] },
    { folder: "세계수의정원", title: "Garden of Yggdrasil", artist: "Alltoy24", charts: ["normal_1.json", "hard_6.json", "troll_13.json"] },
    { folder: "Test", title: "Test Map", artist: "Alltoy24", charts: ["normal_2.json"] }
];

// [헬퍼] 방 목록 포맷팅
function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id, title: r.title, host: r.hostName,
        status: r.status, pCount: r.players.length
    }));
}

// [헬퍼] 게임 시작 시퀀스 (2명 찼을 때 호출)
function startGameSequence(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.status = "PLAYING";
    
    // 랜덤 곡 & 난이도 선정
    const randomSong = SONG_DB[Math.floor(Math.random() * SONG_DB.length)];
    const randomChart = randomSong.charts[Math.floor(Math.random() * randomSong.charts.length)];
    const diffKey = randomChart.replace(".json", ""); // "hard_8"

    console.log(`🚀 Start: ${roomId} | ${randomSong.title} [${diffKey}]`);

    // 게임 시작 신호 전송 (이펙트 시간 등 고려하여 2.5초 + 15초 뒤)
    io.to(roomId).emit("game_start", {
        songFolder: randomSong.folder,
        songTitle: randomSong.title,
        songArtist: randomSong.artist,
        diffKey: diffKey,
        startTime: Date.now() + 21000 
    });

    io.emit("update_room_list", getRoomList());
}

io.on("connection", (socket) => {
    console.log(`🔌 Connect: ${socket.id}`);

    // 1. 방 목록 요청
    socket.on("request_room_list", () => {
        socket.emit("update_room_list", getRoomList());
    });

    // 2. 방 만들기
    socket.on("create_room", (data) => {
        const roomId = `room_${roomSeq++}`;
        rooms[roomId] = {
            id: roomId,
            title: data.title,
            hostId: socket.id,
            hostName: data.nickname,
            players: [{ socketId: socket.id, nickname: data.nickname, ready: true }],
            status: "WAITING"
        };
        socket.join(roomId);
        socket.emit("room_joined", { roomId, roomData: rooms[roomId], isHost: true });
        io.emit("update_room_list", getRoomList());
    });

    // 3. 방 입장
    socket.on("join_room", (data) => {
        const { roomId, nickname } = data;
        const room = rooms[roomId];

        if (!room) { socket.emit("error_msg", "존재하지 않는 방입니다."); return; }
        if (room.players.length >= 2) { socket.emit("error_msg", "방이 꽉 찼습니다."); return; }

        room.players.push({ socketId: socket.id, nickname: nickname, ready: true });
        socket.join(roomId);

        socket.emit("room_joined", { roomId, roomData: room, isHost: false });
        socket.to(roomId).emit("player_entered", { nickname: nickname });
        io.emit("update_room_list", getRoomList());

        // ★ [자동 시작] 2명이 되면 바로 시작
        if (room.players.length === 2) {
            startGameSequence(roomId);
        }
    });

    // 4. [퀵 매치] 핵심 로직
    socket.on("quick_match", (data) => {
        // 대기 중이고 1명인 방 찾기
        const availableRoom = Object.values(rooms).find(r => r.status === "WAITING" && r.players.length < 2);

        if (availableRoom) {
            // 빈 방이 있으면 ID를 클라에게 줌 -> 클라가 join_room 호출
            console.log(`⚔️ QuickMatch Found: ${availableRoom.id}`);
            socket.emit("quick_match_found", availableRoom.id);
        } else {
            // 빈 방이 없으면 방 생성 (create_room 로직 복사)
            const roomId = `room_${roomSeq++}`;
            rooms[roomId] = {
                id: roomId,
                title: `${data.nickname}'s Match`,
                hostId: socket.id,
                hostName: data.nickname,
                players: [{ socketId: socket.id, nickname: data.nickname, ready: true }],
                status: "WAITING"
            };
            socket.join(roomId);
            socket.emit("room_joined", { roomId, roomData: rooms[roomId], isHost: true });
            io.emit("update_room_list", getRoomList());
            console.log(`⚔️ QuickMatch Created: ${roomId}`);
        }
    });

    // 5. 나가기/접속해제
    const handleLeave = () => {
        for (const rId in rooms) {
            const room = rooms[rId];
            const idx = room.players.findIndex(p => p.socketId === socket.id);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                socket.leave(rId);

                if (room.players.length === 0) {
                    delete rooms[rId];
                } else {
                    room.status = "WAITING";
                    io.to(rId).emit("opponent_left");
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
// ★ 6. API 기능들 (기존 기능 유지)
// ==========================================
app.post("/api/score", verifySignature, async (req, res) => {
  const { userId, userName, song, diff, score, level } = req.body;
  try {
    const cleanScore = Number(score);
    const cleanLevel = Number(level);
    if (isNaN(cleanScore) || cleanScore > 1000000) return res.status(400).json({ error: "점수 오류" });

    await Score.updateOne(
      { userId, song, diff }, 
      { $max: { score: cleanScore }, $set: { userName: userName, level: cleanLevel || 1 } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: true });
    res.status(500).json({ error: "DB Error" });
  }
});

app.get("/api/ranking/:song/:diff", async (req, res) => {
  const { song, diff } = req.params;
  try {
    const leaderboard = await Score.find({ song, diff }).sort({ score: -1 }).limit(50).select('userName score level -_id'); 
    res.json(leaderboard);
  } catch (e) { res.status(500).json([]); }
});

app.get("/api/user/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    let user = await User.findOne({ userId });
    if (!user) user = { level: 1, xp: 0, nickname: null };
    res.json(user);
  } catch (e) { res.status(500).json({ level: 1, xp: 0, nickname: null }); }
});

app.post("/api/user/update", async (req, res) => {
  const { userId, level, xp, nickname } = req.body;
  try {
    const updateData = {};
    if (level !== undefined) updateData.level = Number(level);
    if (xp !== undefined) updateData.xp = Number(xp);
    if (nickname !== undefined) updateData.nickname = String(nickname).substring(0, 12); 

    await User.findOneAndUpdate({ userId }, { $set: updateData }, { upsert: true, new: true });
    if (nickname) await Score.updateMany({ userId: userId }, { $set: { userName: nickname } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "DB Error" }); }
});

// 서버 시작
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`🛡️ Secure Server & Socket.io running on port ${port}`);
});