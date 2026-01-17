const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const app = express();

app.use(express.json());
app.use(cors());

// ==========================================
// ★ 1. MongoDB 연결
// ==========================================
// ▼▼▼ 비밀번호 꼭 다시 넣으세요! ▼▼▼
const PASSWORD = "uokq9LwPpZdi0bd9"; 
const MONGO_URI = `mongodb+srv://yunhogim528_db_user:${PASSWORD}@trollbeatserverdata.9tidzxa.mongodb.net/?retryWrites=true&w=majority&appName=TrollBeatServerData`;

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB 연결 성공!"))
  .catch(err => console.error("🔥 DB 연결 실패:", err));

// ==========================================
// ★ 2. 데이터 모델 (강력한 중복 방지 적용)
// ==========================================

const scoreSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  song: String,
  diff: String,
  score: Number,
  level: Number
});

// ★★★ [핵심] 유저+곡+난이도 조합은 유일해야 한다! (중복 원천 차단)
scoreSchema.index({ userId: 1, song: 1, diff: 1 }, { unique: true });

const Score = mongoose.model("Score", scoreSchema);

// 유저 레벨 모델
const userSchema = new mongoose.Schema({
  userId: String,
  level: Number,
  xp: Number
});
const User = mongoose.model("User", userSchema);

// ==========================================
// ★ 3. API 기능들
// ==========================================

// [기능 1] 점수 저장 (중복 방지 로직 적용)
app.post("/api/score", async (req, res) => {
  const { userId, userName, song, diff, score, level } = req.body;

  try {
    // 1. 일단 업데이트를 시도해본다. (기록이 있으면 점수 비교 후 갱신)
    // $max: 점수가 기존보다 높을 때만 수정함
    // $set: 이름과 레벨은 무조건 최신으로 수정함
    // upsert: true -> 없으면 새로 만듦
    await Score.updateOne(
      { userId, song, diff }, 
      { 
        $max: { score: score }, 
        $set: { userName: userName, level: level || 1 } 
      },
      { upsert: true }
    );

    console.log(`[SAVE] ${userName} - ${song}: ${score}`);
    res.json({ success: true });

  } catch (e) {
    // 혹시라도 동시에 들어와서 충돌나면 무시 (어차피 하나는 저장됨)
    if (e.code === 11000) {
        console.log("⚠️ 중복 저장 방어 성공");
        return res.json({ success: true });
    }
    console.error(e);
    res.status(500).json({ error: "DB Error" });
  }
});

// [기능 2] 랭킹 조회 (TOP 50)
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
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "DB Error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});