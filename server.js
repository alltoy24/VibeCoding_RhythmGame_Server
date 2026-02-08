require("dotenv").config(); // Load .env file
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet"); // Security headers
const rateLimit = require("express-rate-limit"); // Anti-spam
const http = require("http");
const { Server } = require("socket.io");

const app = express();

// Wrap Express app with HTTP server (Required for Socket.io)
const server = http.createServer(app);

// Socket.io Setup (CORS Allowed)
const io = new Server(server, {
    cors: {
        origin: "*", // In production, restrict this to your client's domain
        methods: ["GET", "POST"]
    }
});

// Trust Proxy Setting (Required for deployment platforms like Cloudtype/Heroku)
app.set('trust proxy', 1);

// ==========================================
// ★ 1. Security Middleware Configuration
// ==========================================
app.use(helmet()); 
app.use(express.json({ limit: '10kb' })); // Limit request body size to prevent DDOS
app.use(cors());

// [Anti-Spam] Limit to 100 requests per 15 minutes per IP
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: "Too many requests. Please try again later." }
});
app.use("/api/", limiter);

// ==========================================
// ★ 2. MongoDB Connection
// ==========================================
mongoose.connect(process.env.MONGO_URI)
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
  timestamp: { type: Date, default: Date.now } // Automatically save timestamp
});
scoreSchema.index({ userId: 1, song: 1, diff: 1 }, { unique: true });
const Score = mongoose.model("Score", scoreSchema);

const userSchema = new mongoose.Schema({
  userId: String,
  nickname: String,
  level: Number,
  xp: Number,
  // ★ Additional User Stats
  rating: { type: Number, default: 1000 }, // Default rating
  tier: { type: String, default: "Bronze" },
  matchCount: { type: Number, default: 0 },
  winCount: { type: Number, default: 0 }
});
const User = mongoose.model("User", userSchema);

// ==========================================
// ★ 4. Security Verification Function (Core!)
// ==========================================
const verifySignature = (req, res, next) => {
    // 1. Receive data from client
    const { userId, score, maxCombo, signature, playTime } = req.body;
    
    // 2. Check for missing required data
    if (!userId || score === undefined || maxCombo === undefined || !signature) {
        console.log("❌ Missing Data:", { userId, score, maxCombo, signature });
        return res.status(400).json({ error: "Invalid Request (Missing Data)" });
    }

    // 3. Playtime Validation (Simple Anti-Cheat)
    if (playTime && playTime < 10000) {
        console.warn(`🚨 [HACK] PlayTime too short: ${playTime}ms (${userId})`);
        return res.status(403).json({ error: "Abnormal play detected" });
    }

    // 4. Signature Verification Logic
    const serverSecret = process.env.SECRET_SALT || "WebBeat_Secure_Key_2026_Ver42"; 
    const rawString = `${userId}_${score}_${maxCombo}_${serverSecret}`;
    const expectedSignature = Buffer.from(rawString).toString('base64');

    // 5. Comparison
    if (signature !== expectedSignature) {
        console.log("---------------------------------------");
        console.log("🚨 [Signature Mismatch] Hack Suspected!");
        return res.status(403).json({ error: "Data Tampering Detected" });
    }

    // Pass!
    next();
};

// ==========================================
// ★ 5. [Multiplayer Logic] Fully Implemented
// ==========================================

// In-memory storage for rooms
let rooms = {}; 
let roomSeq = 1; 

// Song Database (Must match folder names in song_list.json)
const SONG_DB = [
    { 
        folder: "NewEra", 
        title: "New Era", 
        artist: "Alltoy24", 
        charts: ["normal_4.json", "hard_8.json", "troll_11.json"] 
    },
    { 
        folder: "세계수의정원", 
        title: "Garden of Yggdrasil", 
        artist: "Alltoy24", 
        charts: ["normal_1.json", "hard_6.json", "troll_13.json"] 
    },
    { 
        folder: "Test", 
        title: "Test Map", 
        artist: "Alltoy24", 
        charts: ["normal_2.json"] 
    }
];

// Helper: Convert room object to array for client
function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id,
        title: r.title,
        host: r.hostName,
        status: r.status,
        pCount: r.players.length
    }));
}

// Helper: Game Start Sequence (Called when room is full)
function startGameSequence(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.status = "PLAYING";
    
    // 1. Select Random Song
    const randomSong = SONG_DB[Math.floor(Math.random() * SONG_DB.length)];
    
    // 2. Select Random Difficulty
    const randomChart = randomSong.charts[Math.floor(Math.random() * randomSong.charts.length)];
    const diffKey = randomChart.replace(".json", ""); // e.g., "hard_8"

    console.log(`🚀 Start Game: Room ${roomId} | Song: ${randomSong.title} | Diff: ${diffKey}`);

    // 3. Send Game Start Signal to Room
    // Delay: 3s (Effect) + 3s (Info Reveal) + 15s (Countdown) = 21s
    const startDelay = 21000;
    const startTime = Date.now() + startDelay;

    io.to(roomId).emit("game_start", {
        songFolder: randomSong.folder,
        songTitle: randomSong.title,
        songArtist: randomSong.artist,
        diffKey: diffKey,
        startTime: startTime 
    });

    // 4. Update Lobby List (Status changed to PLAYING)
    io.emit("update_room_list", getRoomList());
}

io.on("connection", (socket) => {
    console.log(`🔌 Client Connected: ${socket.id}`);

    // --- 1. Request Room List ---
    socket.on("request_room_list", () => {
        socket.emit("update_room_list", getRoomList());
    });

    // --- 2. Create Room ---
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
        
        // Notify creator
        socket.emit("room_joined", { 
            roomId, 
            roomData: rooms[roomId], 
            isHost: true 
        });

        // Broadcast to everyone
        io.emit("update_room_list", getRoomList());
        console.log(`🏠 Room Created: ${data.title} (${roomId})`);
    });

    // --- 3. Join Room ---
    socket.on("join_room", (data) => {
        const { roomId, nickname } = data;
        const room = rooms[roomId];

        if (!room) {
            socket.emit("error_msg", "Room does not exist.");
            return;
        }
        if (room.players.length >= 2) {
            socket.emit("error_msg", "Room is full.");
            return;
        }

        // Add player
        room.players.push({ socketId: socket.id, nickname: nickname, ready: true });
        socket.join(roomId);

        // Notify joiner
        socket.emit("room_joined", { roomId, roomData: room, isHost: false });
        
        // Notify existing players (Host)
        socket.to(roomId).emit("player_entered", { nickname: nickname });

        // Broadcast updated list (pCount changed)
        io.emit("update_room_list", getRoomList());
        console.log(`🏃 Room Joined: ${nickname} -> ${roomId}`);

        // ★ Check for Auto-Start Condition
        if (room.players.length === 2) {
            startGameSequence(roomId);
        }
    });

    // --- 4. Quick Match ---
    socket.on("quick_match", (data) => {
        // Find a room that is WAITING and has 1 player
        const availableRoom = Object.values(rooms).find(r => r.status === "WAITING" && r.players.length < 2);

        if (availableRoom) {
            // Found a room! Tell client to join this ID.
            console.log(`⚔️ QuickMatch Found: ${availableRoom.id}`);
            socket.emit("quick_match_found", availableRoom.id);
        } else {
            // No room found. Create a new one.
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
            
            // Notify creator
            socket.emit("room_joined", { roomId, roomData: rooms[roomId], isHost: true });
            
            // Broadcast new room
            io.emit("update_room_list", getRoomList());
            console.log(`⚔️ QuickMatch Created New Room: ${roomId}`);
        }
    });

    // --- 5. Disconnect / Leave Room Logic ---
    const handleLeave = () => {
        // Iterate through all rooms to find the user
        for (const rId in rooms) {
            const room = rooms[rId];
            const idx = room.players.findIndex(p => p.socketId === socket.id);
            
            if (idx !== -1) {
                // Remove player
                room.players.splice(idx, 1);
                socket.leave(rId);

                if (room.players.length === 0) {
                    // Room empty -> Delete room
                    delete rooms[rId];
                    console.log(`🗑️ Room Deleted: ${rId}`);
                } else {
                    // Room not empty -> Reset status to WAITING and notify remaining player
                    room.status = "WAITING";
                    io.to(rId).emit("opponent_left");
                    console.log(`👋 User Left Room: ${rId}`);
                }
                
                // Update lobby list
                io.emit("update_room_list", getRoomList());
                break; // User found and processed, stop loop
            }
        }
    };

    socket.on("leave_room", handleLeave);
    socket.on("disconnect", handleLeave);
});


// ==========================================
// ★ 6. API Endpoints (Preserved)
// ==========================================

// [API 1] Save Score (With Verification)
app.post("/api/score", verifySignature, async (req, res) => {
  const { userId, userName, song, diff, score, level } = req.body;

  try {
    const cleanScore = Number(score);
    const cleanLevel = Number(level);

    if (isNaN(cleanScore) || cleanScore > 1000000) { 
        return res.status(400).json({ error: "Invalid Score" });
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

// [API 2] Get Ranking
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

// [API 3] Get User Info
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

// [API 4] Update User Info
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
// ★ Start Server
// ==========================================
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`🛡️ Secure Server & Socket.io running on port ${port}`);
});