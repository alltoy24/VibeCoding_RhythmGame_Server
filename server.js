const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const app = express();

app.use(express.json());
app.use(cors());

// ==========================================
// ★ 1. MongoDB 연결
// ==========================================
const PASSWORD = "uokq9LwPpZdi0bd9"; 
const MONGO_URI = `mongodb+srv://yunhogim528_db_user:${PASSWORD}@trollbeatserverdata.9tidzxa.mongodb.net/?retryWrites=true&w=majority&appName=TrollBeatServerData`;

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB 연결 성공!"))
  .catch(err => console.error("🔥 DB 연결 실패:", err));

// ==========================================
// ★ 2. 데이터 모델
// ==========================================

// 랭킹 점수 모델
const scoreSchema = new mongoose.Schema({
  userId: String,
  userName: String, // 랭킹에 표시될 닉네임
  song: String,
  diff: String,
  score: Number,
  level: Number
});
// 유저+곡+난이도 조합은 유일함 (중복 방지)
scoreSchema.index({ userId: 1, song: 1, diff: 1 }, { unique: true });
const Score = mongoose.model("Score", scoreSchema);

// 유저 정보 모델 (닉네임 필드 추가됨!)
const userSchema = new mongoose.Schema({
  userId: String,
  nickname: String, // ★ [NEW] 닉네임 저장용
  level: Number,
  xp: Number
});
const User = mongoose.model("User", userSchema);

// ==========================================
// ★ 3. API 기능들
// ==========================================

// [기능 1] 점수 저장
app.post("/api/score", async (req, res) => {
  // 클라이언트가 보낸 닉네임을 userName으로 받음
  const { userId, userName, song, diff, score, level } = req.body;

  try {
    await Score.updateOne(
      { userId, song, diff }, 
      { 
        $max: { score: score }, 
        $set: { userName: userName, level: level || 1 } 
      },
      { upsert: true }
    );
    console.log(`[SCORE] ${userName} - ${song}: ${score}`);
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
      .limit(50);
    res.json(leaderboard);
  } catch (e) {
    res.status(500).json([]);
  }
});

// [기능 3] 내 정보 가져오기 (닉네임 포함)
app.get("/api/user/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    let user = await User.findOne({ userId });
    
    // 유저 정보가 없으면 기본값 리턴
    if (!user) {
        user = { level: 1, xp: 0, nickname: null };
    }
    res.json(user);
  } catch (e) {
    res.status(500).json({ level: 1, xp: 0, nickname: null });
  }
});

// [기능 4] 내 정보 업데이트 (닉네임 동기화 기능 추가)
app.post("/api/user/update", async (req, res) => {
  const { userId, level, xp, nickname } = req.body;
  
  // 업데이트할 데이터 꾸리기
  const updateData = {};
  if (level !== undefined) updateData.level = level;
  if (xp !== undefined) updateData.xp = xp;
  if (nickname !== undefined) updateData.nickname = nickname;

  try {
    // 1. 유저 테이블 업데이트
    await User.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { upsert: true, new: true }
    );

    // ★ 2. 만약 닉네임이 바뀌었다면? -> 랭킹판(Score)에 있는 내 이름도 싹 다 바꾼다!
    if (nickname) {
        await Score.updateMany(
            { userId: userId },
            { $set: { userName: nickname } }
        );
        console.log(`[UPDATE] 유저(${userId}) 닉네임 변경 및 랭킹 동기화 완료: ${nickname}`);
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB Error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});