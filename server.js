const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const app = express();

app.use(express.json());
app.use(cors());

// ==========================================
// ★ 1. MongoDB 연결 (비밀번호 꼭 넣으세요!)
// ==========================================
// ▼▼▼ 여기에 비밀번호 입력 ▼▼▼
const PASSWORD = "uokq9LwPpZdi0bd9"; 
const MONGO_URI = `mongodb+srv://yunhogim528_db_user:${PASSWORD}@trollbeatserverdata.9tidzxa.mongodb.net/?retryWrites=true&w=majority&appName=TrollBeatServerData`;

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB 연결 성공!"))
  .catch(err => console.error("🔥 DB 연결 실패:", err));

// ==========================================
// ★ 2. 데이터 모델 (장부 양식)
// ==========================================

// 랭킹 장부 (레벨 항목 추가됨)
const scoreSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  song: String,
  diff: String,
  score: Number,
  level: Number // ★ 추가됨
});
const Score = mongoose.model("Score", scoreSchema);

// 유저 레벨 장부
const userSchema = new mongoose.Schema({
  userId: String,
  level: Number,
  xp: Number
});
const User = mongoose.model("User", userSchema);

// ==========================================
// ★ 3. API 기능들
// ==========================================

// [기능 1] 점수 저장 (신기록 & 레벨 동시 저장)
app.post("/api/score", async (req, res) => {
  const { userId, userName, song, diff, score, level } = req.body;

  try {
    const existing = await Score.findOne({ userId, song, diff });

    if (existing) {
      // 기록이 있으면 -> 점수가 더 높을 때만 갱신
      if (score >= existing.score) {
        existing.score = score;
        existing.userName = userName;
        existing.level = level || 1; // 레벨도 최신으로 업데이트
        await existing.save();
        console.log(`[UP] ${userName} - ${song}: ${score}`);
      }
    } else {
      // 기록이 없으면 -> 새로 만듦
      await Score.create({ userId, userName, song, diff, score, level: level || 1 });
      console.log(`[NEW] ${userName} - ${song}: ${score}`);
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB Error" });
  }
});

// [기능 2] 랭킹 조회 (TOP 50)
app.get("/api/ranking/:song/:diff", async (req, res) => {
  const { song, diff } = req.params;
  try {
    const leaderboard = await Score.find({ song, diff })
      .sort({ score: -1 }) // 점수 높은 순
      .limit(50);          // 50등까지 자르기
    res.json(leaderboard);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

// [기능 3] 내 레벨 가져오기
app.get("/api/user/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    let user = await User.findOne({ userId });
    if (!user) user = { level: 1, xp: 0 };
    res.json(user);
  } catch (e) {
    res.status(500).json({ level: 1, xp: 0 });
  }
});

// [기능 4] 내 레벨 저장하기
app.post("/api/user/update", async (req, res) => {
  const { userId, level, xp } = req.body;
  try {
    await User.findOneAndUpdate(
      { userId },
      { level, xp },
      { upsert: true, new: true }
    );
    // console.log(`[USER] ${userId} -> LV.${level}`);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB Error" });
  }
});

// 서버 실행
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});