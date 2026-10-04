# WEB BEAT API

Cloudflare Worker와 D1으로 동작하는 WEB BEAT의 점수, 랭킹, 유저 데이터 API입니다.

## 처음 한 번만 할 일

1. Cloudflare에서 Worker 이름 `webbeat-api`와 D1 데이터베이스 `webbeat-db`를 만듭니다.
2. D1 콘솔에서 [`schema.sql`](./schema.sql)의 내용을 실행합니다.
3. 이 저장소의 `main` 브랜치에 푸시합니다. Cloudflare Workers Builds가 `npx wrangler deploy`를 실행해 배포합니다.
4. 배포 후 아래 주소를 브라우저에서 엽니다.

   ```text
   https://webbeat-api.yunhogim528.workers.dev/health
   ```

   `{"ok":true,"service":"webbeat-api","storage":"D1"}`가 보이면 정상입니다.

`wrangler.jsonc`에는 이미 `webbeat-db`의 `DB` 바인딩이 들어 있습니다. 대시보드에서 같은 바인딩을 따로 추가할 필요는 없습니다.

## 로컬 확인

```text
npm install
npm run dev
```

원격 D1에 테이블을 만들 때는 다음 명령을 사용합니다.

```text
npm run db:schema
```

## 제공 API

- `GET /health`
- `POST /api/score`
- `GET /api/ranking/:song/:diff`
- `GET /api/user/:userId`
- `POST /api/user/update`

점수·랭킹·유저 API는 D1으로 이전되었습니다. 기존 Socket.IO 멀티플레이는 Cloudflare Durable Object WebSocket 전환 작업이 별도로 필요합니다.
