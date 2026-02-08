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

let rooms = {}; 
let roomSeq = 1; // 방 번호 생성용

io.on("connection", (socket) => {
    console.log(`🔌 [Socket] 접속: ${socket.id}`);

    // 1. [로비 입장] 방 목록 요청
    socket.on("request_room_list", () => {
        // rooms 객체를 배열로 변환해서 보냄
        const list = Object.values(rooms).map(r => ({
            id: r.id,
            title: r.title,
            host: r.hostName,
            status: r.status,
            pCount: r.players.length,
            lock: false
        }));
        socket.emit("update_room_list", list);
    });

    // 2. [방 만들기]
    socket.on("create_room", (data) => {
        // data: { title, nickname, ... }
        const roomId = `room_${roomSeq++}`;
        
        rooms[roomId] = {
            id: roomId,
            title: data.title,
            hostId: socket.id,
            hostName: data.nickname,
            players: [{ socketId: socket.id, nickname: data.nickname, ready: true }], // 방장은 자동 레디
            status: "WAITING"
        };

        socket.join(roomId);
        
        // 만든 사람에게 "입장 성공" 알림
        socket.emit("room_joined", { 
            roomId, 
            roomData: rooms[roomId], 
            isHost: true 
        });

        // 전체에게 방 목록 갱신 알림
        io.emit("update_room_list", Object.values(rooms));
        console.log(`🏠 방 생성: ${data.title} (${roomId})`);
    });

    // 3. [방 입장] (목록 클릭 or 퀵매치)
    socket.on("join_room", (data) => {
        const { roomId, nickname } = data;
        const room = rooms[roomId];

        if (!room) {
            socket.emit("error_msg", "존재하지 않는 방입니다.");
            return;
        }
        if (room.players.length >= 2) {
            socket.emit("error_msg", "방이 꽉 찼습니다.");
            return;
        }

        // 입장 처리
        room.players.push({ socketId: socket.id, nickname: nickname, ready: false });
        socket.join(roomId);

        // 1) 나에게 방 정보 전송
        socket.emit("room_joined", { roomId, roomData: room, isHost: false });
        
        // 2) 방 안에 있던 사람(방장)에게 "누가 들어왔다" 알림
        socket.to(roomId).emit("player_entered", { nickname: nickname });

        // 3) 로비에 방 인원수 변경 알림
        io.emit("update_room_list", Object.values(rooms));
        console.log(`🏃 방 입장: ${nickname} -> ${roomId}`);
    });

    // 4. [퀵 매치] 빈 방 찾기
    socket.on("quick_match", (data) => {
        // WAITING 상태이고 인원이 1명인 방 찾기
        const availableRoom = Object.values(rooms).find(r => r.status === "WAITING" && r.players.length < 2);

        if (availableRoom) {
            // 빈 방 있으면 입장 시도 (위의 join_room 로직 재사용 가능하지만 직접 호출)
            // 클라이언트에게 "이 방으로 들어가라"고 시킴
            socket.emit("quick_match_found", availableRoom.id);
        } else {
            // 빈 방 없으면 방 생성 (방 제목: 유저님의 방)
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
            io.emit("update_room_list", Object.values(rooms));
        }
    });

    // 5. [게임 시작] 방장이 누름
    socket.on("start_game_request", (roomId) => {
        const room = rooms[roomId];
        if (room && room.hostId === socket.id && room.players.length === 2) {
            room.status = "PLAYING";
            
            // 곡 랜덤 선정 (혹은 선택된 곡)
            const songs = ["Alien", "Aurora", "BlackBox"]; // 예시
            const selectedSong = songs[Math.floor(Math.random() * songs.length)];

            // 3초 뒤 시작 신호
            const startTime = Date.now() + 3000;
            io.to(roomId).emit("game_start", { 
                song: selectedSong, 
                startTime: startTime 
            });
            
            // 로비 목록 갱신 (상태 변경)
            io.emit("update_room_list", Object.values(rooms));
        }
    });

    // 6. [나가기 / 접속해제]
    const handleLeave = () => {
        // 내가 속한 방 찾기
        // (실제로는 socket.rooms 등을 쓰거나 userMap을 만들어 관리하는게 효율적이지만 간단히 순회)
        for (const rId in rooms) {
            const room = rooms[rId];
            const idx = room.players.findIndex(p => p.socketId === socket.id);
            if (idx !== -1) {
                // 플레이어 제거
                room.players.splice(idx, 1);
                socket.leave(rId);

                if (room.players.length === 0) {
                    // 사람 없으면 방 폭파
                    delete rooms[rId];
                } else {
                    // 사람 남았으면 방장 위임 등 처리 (간단히는 남은 사람에게 알림)
                    room.status = "WAITING"; // 다시 대기 상태
                    io.to(rId).emit("opponent_left"); // 상대 나감 알림
                }
                
                io.emit("update_room_list", Object.values(rooms)); // 로비 갱신
                break;
            }
        }
    };

    socket.on("leave_room", handleLeave);
    socket.on("disconnect", handleLeave);
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