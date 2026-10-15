# 학교 PC 자체 서버 운영 안내 (Windows)

학교 교사망의 고정 IP Windows PC 한 대로 모아를 운영하는 방법이다. 현재 운영 중인 Cloudflare Worker + Supabase 무료 배포와 같은 코드(Node 모드)를 쓰며, 무료 한도(하루 10만 쿼리·월 5GB 전송·DB 500MB·사진 1GB·실시간 200연결)가 없어진다. 대신 PC 전원·백업·보안 업데이트를 직접 관리한다.

구성(`deploy/selfhost/compose.yaml`): 앱(Next.js) · PostgreSQL · ClamAV(문서 검사) · Caddy(HTTPS 자동) · 매일 정리 작업 · 매일 백업. 바깥으로 열리는 포트는 Caddy의 80·443뿐이다.

> 이 묶음은 저장소에서 빌드·정리 스크립트·설정 문법까지 검증했다. Docker로 실제 기동한 검증은 아직 하지 않았으므로 첫 설치 때 아래 "확인" 단계를 꼭 거친다.

## 0. 먼저 확인할 것 (설치 전, 10분)

1. **공인 IP인지**: 서버 PC에서 `ipconfig`의 IPv4 주소와 브라우저에서 연 `https://ifconfig.me` 주소를 비교한다.
   - 같으면 PC가 공인 IP를 직접 갖고 있다.
   - 다르면(10.x · 172.16~31.x · 192.168.x) 학교 장비 뒤에 있다. 학교 정보 담당자(또는 교육청 망 담당)에게 **공인 IP의 TCP 80·443을 이 PC로 전달(포트포워딩)** 해 달라고 요청한다.
2. **외부 공개 허용**: 교사망 PC를 외부에 서비스로 여는 것은 교육청 정보보안 정책상 신청·승인이 필요할 수 있다. 학생 개인정보가 이 PC에 저장되므로 학교 개인정보 처리 방침도 확인한다.
3. **학교 안에서의 접속**: 학교 Wi-Fi·학생망에서 공인 주소로 다시 들어오는 경로(헤어핀 NAT)가 막힌 장비도 있다. 설치 후 학교 Wi-Fi와 휴대전화 데이터 양쪽에서 접속해 본다.

## 1. 도메인과 Google 로그인

1. 학교 도메인 DNS에 **A 레코드** `moa.samjeong.ms.kr → (공인 IP)` 를 추가한다. 이름은 바꿔도 되며 `.env`의 `DOMAIN`과 같아야 한다.
2. Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보 → 지금 쓰는 OAuth 클라이언트에 추가:
   - 승인된 JavaScript 원본: `https://moa.samjeong.ms.kr`
   - 승인된 리디렉션 URI: `https://moa.samjeong.ms.kr/api/auth/google/callback`
   (기존 workers.dev 주소는 그대로 둬도 된다. 같은 클라이언트 ID/비밀번호를 쓴다.)

## 2. PC 준비

1. **Docker Desktop** 설치(WSL 2 사용). 학교·교육용 비상업 사용은 무료 범위이나 설치 전 Docker 이용 약관을 확인한다.
   - Docker Desktop 설정 → General → **Start Docker Desktop when you sign in** 켜기.
   - Docker Desktop은 Windows에 로그인해야 실행된다. 재부팅 후 자동으로 서비스되려면 서버 PC에 자동 로그인을 설정하거나, 재부팅 후 로그인하는 운영 규칙을 둔다.
2. 전원 옵션: **절전·최대 절전 끄기**, 모니터만 꺼지게. Windows 업데이트의 사용 시간(재부팅 금지 시간)을 수업 시간으로 설정한다.
3. 관리자 PowerShell에서 방화벽 허용:
   ```powershell
   New-NetFirewallRule -DisplayName "moa https" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow
   ```
4. Git 설치 후 코드를 받는다:
   ```powershell
   git clone https://github.com/soomsci/SJPadlet.git C:\moa
   ```

## 3. 설정과 실행

```powershell
cd C:\moa\deploy\selfhost
copy .env.example .env
notepad .env        # DOMAIN, POSTGRES_PASSWORD, GOOGLE_CLIENT_ID/SECRET 등을 채운다
docker compose up -d --build
```

- `POSTGRES_PASSWORD`는 길고 무작위로: PowerShell `[guid]::NewGuid().ToString('N')`.
- 교사·관리자 명단은 운영 `wrangler.jsonc`와 같게 넣는다. `GOOGLE_DIRECTORY_KEY`(교사 그룹 확인 키)는 운영 Worker의 secret과 같은 값을 넣는다.
- `.env`는 Git에 올라가지 않는다(`deploy/selfhost/.gitignore`).

**확인**
```powershell
docker compose ps                 # 모든 서비스가 running (db는 healthy)
docker compose logs -f caddy      # 인증서 발급 성공 메시지 확인 (실패 시 80/443 외부 접근 문제)
```
그다음 휴대전화 데이터로 `https://moa.samjeong.ms.kr/api/health` → `{"data":{"status":"ok"}}`, 교사 Google 로그인, 학생 QR 참여·사진 올리기를 확인한다.

## 4. 운영

| 작업 | 방법 |
|---|---|
|코드 업데이트|`cd C:\moa; git pull; cd deploy\selfhost; docker compose up -d --build`|
|매일 정리(03:00)|`daily` 서비스가 오래된 첨부·휴지통 30일 게시판 정리, 교사 그룹 재확인. `docker compose logs daily`|
|매일 백업(02:30)|`backup` 서비스가 `deploy\selfhost\backups`에 `moa-날짜.dump`(DB)와 `uploads-날짜.tgz`(사진·파일)를 만들고 14일 지난 것은 지운다|
|백업 보관|같은 PC 디스크가 고장 나면 백업도 잃는다. `backups` 폴더를 NAS나 Google Drive 동기화 폴더로 매일 복사한다|
|중지·재시작|`docker compose stop` / `docker compose start`|

**복원** (새 PC 또는 사고 후):
```powershell
docker compose up -d db
docker compose cp backups\moa-YYYYMMDD.dump db:/tmp/restore.dump
docker compose exec db pg_restore -U moa -d moa --clean --if-exists /tmp/restore.dump
docker compose run --rm -v "${PWD}\backups:/b" app sh -c "tar -xzf /b/uploads-YYYYMMDD.tgz -C /app/.data/uploads"
docker compose up -d
```

## 5. 무료 배포와 다른 점

- **스키마**: 앱이 시작할 때 `packages/db/schema.ts`(멱등)를 적용한다. Supabase 전용 마이그레이션(RLS·Realtime·Storage)은 쓰지 않는다.
- **실시간**: Supabase Realtime 대신 서버가 접속마다 1초 간격으로 변경을 확인해 알린다(SSE). 권한 회수가 1초 안에 반영된다.
- **업로드**: 사진뿐 아니라 PDF·문서(20MB 이하)도 올릴 수 있고 ClamAV가 검사한다. ClamAV가 준비되기 전(첫 실행 몇 분) 올린 파일은 격리되어 열리지 않는다. 한도는 게시판 1GB·교사 10GB이며 학교 전체 상한이 없으므로 **디스크 여유 공간을 주기적으로 확인**한다.
- **요청 한도**: 접속자별 한도는 Caddy가 넘겨주는 실제 접속 IP를 쓴다. 앱 포트(3000)를 밖으로 열면 이 값이 위조될 수 있으므로 열지 않는다.
- **앱 내 백업 화면**: 학교 관리의 백업·복원 패널은 Supabase 저장소용이라 자체 서버에서는 쓰지 않고, 위의 `backup` 서비스를 쓴다.

## 6. 기존 데이터 옮기기 (아직 미구현)

현재 Supabase에 있는 게시판·글·사진을 이 서버로 옮기는 스크립트는 아직 없다. 옮길 시점이 정해지면 Supabase DB 덤프 → 자체 DB 가져오기, Storage 사진(`classroom-images`) → `uploads` 폴더(저장 키를 파일 이름으로) 복사 순서로 작성한다. 옮기는 동안 Cloudflare 쪽은 참여를 닫아 두어야 한다.
