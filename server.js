const express = require("express");
const mongoose = require("mongoose"); // 몽고DB 도구
const cors = require("cors");
const app = express();

app.use(express.json());
app.use(cors());

// ==========================================
// ★ 1. MongoDB 연결 설정
// ==========================================

// ▼▼▼ 여기에 비밀번호를 넣으세요! (< > 괄호도 지우고 숫자/문자만 입력) ▼▼▼
const PASSWORD = "uokq9LwPpZdi0bd9"; 
const MONGO_URI = `mongodb+srv://yunhogim528_db_user:${PASSWORD}@trollbeatserverdata.9tidzxa.mongodb.net/?retryWrites=true&w=majority&appName=TrollBeatServerData`;

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB 연결 성공! (이제 데이터 안 날아감)"))
  .catch(err => console.error("🔥 DB 연결 실패:", err));

// ==========================================
// ★ 2. 데이터 모델 정의 (공책 양식 만들기)
// ==========================================

// 랭킹 공책 양식
const scoreSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  song: String,
  diff: String,
  score: Number
});
const Score = mongoose.model("Score", scoreSchema);

// 유저 레벨 공책 양식
const userSchema = new mongoose.Schema({
  userId: String,
  level: Number,
  xp: Number
});
const User = mongoose.model("User", userSchema);

// ==========================================
// ★ 3. API 라우트 (기능 구현)
// ==========================================

// [기능 1] 점수 저장 (신기록일 때만 갱신)
app.post("/api/score", async (req, res) => {
  const { userId, userName, song, diff, score } = req.body;

  try {
    // 이미 기록이 있는지 확인
    const existing = await Score.findOne({ userId, song, diff });

    if (existing) {
      // 기록이 있으면 -> 더 높을 때만 업데이트
      if (score > existing.score) {
        existing.score = score;
        existing.userName = userName; // 닉네임 변경 반영
        await existing.save();
        console.log(`[신기록 갱신] ${userName} - ${song}: ${score}`);
      }
    } else {
      // 기록이 없으면 -> 새로 만들기
      await Score.create({ userId, userName, song, diff, score });
      console.log(`[첫 기록] ${userName} - ${song}: ${score}`);
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB Error" });
  }
});

// [기능 2] 랭킹 조회 (TOP 10)
app.get("/api/ranking/:song/:diff", async (req, res) => {
  const { song, diff } = req.params;
  try {
    // DB에서 조건에 맞는거 찾아서 -> 점수 내림차순 -> 10개만 가져오기
    const leaderboard = await Score.find({ song, diff })
      .sort({ score: -1 })
      .limit(10);
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
    if (!user) {
      user = { level: 1, xp: 0 }; // 없으면 기본값
    }
    res.json(user);
  } catch (e) {
    res.status(500).json({ level: 1, xp: 0 });
  }
});

// [기능 4] 내 레벨 저장하기
app.post("/api/user/update", async (req, res) => {
  const { userId, level, xp } = req.body;
  try {
    // 없으면 만들고, 있으면 업데이트 (upsert: true)
    await User.findOneAndUpdate(
      { userId },
      { level, xp },
      { upsert: true, new: true }
    );
    console.log(`[유저 저장] ${userId} -> LV.${level}`);
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