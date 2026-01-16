const express = require("express");
const app = express();
const cors = require("cors");

app.use(express.json());
app.use(cors());

let rankings = [];

// 1. 점수 저장
app.post("/api/score", (req, res) => {
  const { userId, userName, song, diff, score } = req.body;
  
  const existingIndex = rankings.findIndex(r => r.userId === userId && r.song === song && r.diff === diff);
  
  if (existingIndex !== -1) {
    if (score > rankings[existingIndex].score) {
      rankings[existingIndex].score = score;
      rankings[existingIndex].userName = userName;
    }
  } else {
    rankings.push({ userId, userName, song, diff, score });
  }
  
  console.log(`[등록] ${userName} : ${score}`);
  res.json({ success: true });
});

// 2. 랭킹 조회
app.get("/api/ranking/:song/:diff", (req, res) => {
  const { song, diff } = req.params;
  const leaderboard = rankings
    .filter(r => r.song === song && r.diff === diff)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
    
  res.json(leaderboard);
});

// 포트 설정 (클라우드타입이 정해주는 포트 사용)
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});