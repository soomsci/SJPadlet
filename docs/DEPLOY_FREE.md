# Cloudflare + Supabase 무료 시범 배포

2026-10-12. **무료 시범 배포 완료.** 계정 이메일 인증 후 Cloudflare Worker/정적 화면이 배포됐고 상태 API `ok`, 홈페이지, 학교 관리자 Google 로그인, 대시보드/관리 화면과 첫 게시판 생성을 실제 브라우저에서 확인했다. 학생 Google/익명 참여·실시간 변경·사진·학교망 수업 검증은 별도로 남아 있다. 유료 플랜·유료 리소스·사용자 지정 도메인은 구매하지 않았다.

현재 Cloudflare Account ID는 `7577f586f44b23fbc4ebf27e21d19a70`, 등록한 계정 주소는 `samjeong-moa.workers.dev`, 앱 주소는 `https://samjeong-moa.samjeong-moa.workers.dev`다. 첫 관리자와 교사 허용 명단에는 사용자가 지정한 `xopowok08@samjeong.ms.kr`를 설정했다.

현재 위 앱 주소로 Worker가 배포됐다. 실제 Hyperdrive ID는 `4aefb96597d041fd946279e05aa23cd7`이고 대상 DB·캐시 비활성화를 원격 API로 확인했다. `workers_dev=true`, `preview_urls=false`를 유지한다. 버전별 미리보기 URL 비활성화 경고는 운영 주소 오류가 아니며, 해당 경고를 없애기 위해 설정을 켤 필요는 없다. [버전별 URL 설정](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/).

## 구조

- `apps/free-web`: 기존 한국어 React 화면을 재사용하는 Vite 정적 앱. 로그인·대시보드·게시판·학생 참여·공유 QR·관리 화면을 제공한다. `/boards/:id`, `/s/:token` 직접 접근은 SPA fallback으로 처리한다.
- `apps/worker`: 같은 주소의 `/api/*`만 실행하는 Cloudflare Worker. 다른 화면·JS·CSS는 정적 Assets에서 제공한다.
- Supabase PostgreSQL: 기존 관계형 데이터와 권한·트랜잭션을 유지한다. Hyperdrive의 요청별 `pg.Client`로 연결한다. 앱 테이블은 RLS 활성화 및 anon/authenticated 권한 회수로 Data API 직접 접근을 차단한다.
- Google 인증: 기존 Google OIDC state·nonce·PKCE 및 HttpOnly 서버 세션을 유지한다. **Supabase Auth 사용자로 옮긴 구현은 아니다.** Google Workspace `hd`·학교 이메일·교사 명단 검사를 유지하기 위한 선택이다. Supabase는 DB·Storage·Realtime을 담당한다.
- Supabase Storage: `classroom-images` 비공개 버킷. 브라우저는 저장소 비밀키나 서명 다운로드 URL을 받지 않는다. Worker의 권한 검사 후 이미지 본문을 스트리밍한다.
- Supabase Realtime: outbox INSERT 트리거가 빈 `invalidate` 알림만 private 채널에 보낸다. Worker는 현재 게시판 접근이 있는 사람에게 해당 채널용 ES256 JWT를 60초간 발급한다. JWT에 글·이메일·초대 토큰을 넣지 않는다. 브라우저는 45초마다 권한을 재확인하고 토큰을 갱신한다.

일반적인 변경·회수 알림을 받으면 즉시 권한 API를 다시 읽는다. Supabase 채널 권한은 연결 동안 캐시되므로 회수된 연결이 토큰 만료까지 최대 60초간 빈 알림을 더 받을 수 있다. 게시글·파일·새 토큰 API는 회수 직후부터 거부한다. 알림을 놓친 화면은 45초 주기 및 재연결 때 다시 확인한다. 기존 Node 개발 서버의 1초 SSE 재검사와 구분한다.

## 무료 한도와 앱 한도

|항목|사업자 무료 한도|현재 앱 운영 방식|
|---|---|---|
|Cloudflare 정적 파일|정적 요청 무료|SSR 없이 정적 화면 제공|
|Workers API|하루 100,000 요청, 요청당 CPU 10ms|한두 학급 시범 운영 후 실측|
|Hyperdrive|하루 100,000 DB 쿼리|API 한 번에 여러 쿼리 사용; 요청 수와 별도 계측|
|Supabase DB|500MB|텍스트·권한·메타데이터 저장; 정기 백업·정리 필요|
|Supabase 파일|1GB|학교 800MB, 교사 200MB, 게시판 100MB|
|Supabase 전송량|일반 egress 월 5GB, cached egress 별도 5GB|비공개 이미지 전송량을 대시보드에서 확인|
|Realtime|동시 200 연결, 월 200만 메시지|빈 알림과 재조회, 짧은 묶음 처리|

이미지는 브라우저에서 긴 변 1600px 이하 JPEG로 다시 인코딩한다. 원본은 최대 20MB·4천만 픽셀, 최종 업로드는 1MB 이하·글당 5개다. 서버와 버킷도 1MB 한도를 검사한다. 서버가 허용하는 형식은 JPG/PNG/WebP뿐이며 SVG·GIF·PDF·Office·영상은 첨부하지 않는다. 문서와 영상은 사용자가 접근 가능한 Google Drive 등의 링크로 공유한다. 링크 대상의 공유 권한은 해당 서비스에서 설정한다.

무료 이미지 경로는 확장자와 파일 시그니처 검증을 하며 **백신 검사 완료를 의미하지 않는다.** 일반 문서 업로드용 ClamAV는 무료 구성에 배포하지 않는다. 이미지 응답에는 고정 MIME, nosniff, sandbox 및 no-store를 적용한다.

저장 용량 한도는 API가 트랜잭션 잠금으로 검사한다. 전송량·DB 크기·실시간 메시지·Workers CPU를 모두 앱에서 강제 제한하는 구현은 아니다. Free 플랜에서 한도를 초과하면 서비스가 제한될 수 있으며 자동 유료 전환을 전제로 하지 않는다. 두 사업자의 계정을 Free 상태로 유지한다. 파일 삭제·고아 파일 자동 정리 및 자동 백업 예약은 후속 작업이다. 취소한 첨부도 정리 전까지 용량에 포함한다.

[Cloudflare 정적 파일](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/), [Hyperdrive 무료 한도](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [Supabase 무료 플랜](https://supabase.com/pricing).

## 1. 계정과 전용 프로젝트

Cloudflare와 Supabase의 학교 운영용 계정/프로젝트를 사용한다. Supabase는 이 앱 전용 Free 프로젝트로 만들고, 한국과 가까운 제공 리전을 선택한다. 기존 다른 앱의 Supabase 프로젝트에 마이그레이션을 실행하지 않는다. 기존 Storage/Realtime 정책이 발견되면 SQL이 중단되도록 했다.

Cloudflare Account ID와 `workers.dev` 하위 도메인, Supabase Project URL과 publishable key를 확인한다. secret key·DB 암호·Google secret·서명용 개인키는 채팅이나 Git에 넣지 않는다.

## 2. Cloudflare 에이전트 연결 상태

사용자가 지정한 [공식 설정 지침](https://developers.cloudflare.com/agent-setup/prompt.md)을 공식 저장소의 원문과 함께 확인했다. 이 환경에서:

- 최초 시도에서 Cloudflare 공식 스킬 17개를 `.tooling/cloudflare-skills`에 내려받아 참고용으로 보관했다. Git에서 제외된다. 원본 `cloudflare/skills` 커밋은 `c430dd965cea3a8faf0ef035e3b3d73b38518081`이다. 재개 시 `/Users/minsu/.agents/skills`의 공식 스킬 설치와 사용 가능한 스킬 목록을 확인했다.
- 프로젝트 Wrangler 4.149.0과 바인딩 타입을 설치·생성했다.
- 최초 전역 설치/MCP 등록은 권한 제한으로 실패했으나, 재개 시 Cloudflare MCP가 활성화되고 `whoami`와 계정 조회가 성공했다. Worker·Hyperdrive 목록도 조회했다. 목록은 모두 비어 있었다.
- `workers.dev` 서브도메인을 API로 등록하고 재조회했다. 결제/구독 조회는 인증 오류로 거부되어 현재 결제 상태를 확인했다고 주장하지 않는다. 유료 상품을 생성하거나 플랜을 변경하지 않았다.
- Wrangler 로그인은 최초 시도에서 OAuth 콜백 포트 `::1:8976`의 `listen EPERM`으로 실패했다. 재개 시에도 CLI `whoami`는 미로그인이다. **MCP OAuth와 Wrangler CLI 인증은 별개다.** 배포 스크립트를 쓰려면 일반 터미널에서 `npm run cf:login`으로 CLI 인증을 완료해야 한다.
- 선택 사항인 베타 `cf` CLI는 설치하지 않았다.

권한이 허용되는 실행 환경에서 같은 공식 절차를 다시 실행할 수 있도록 `npm run cf:agent:setup` 스크립트를 준비했다. 현재 세션의 MCP는 이미 연결되어 있으므로 불필요하게 재설치하지 않는다. 새 등록·로그인 후 Codex를 재시작하면 MCP 도구가 로드된다.

Wrangler 검증 시 홈 디렉터리 로그 쓰기를 피하기 위해 `.tooling`을 `XDG_CONFIG_HOME`으로, `/private/tmp/padlet-wrangler.log`를 로그 경로로 사용했다. 이때의 프로필은 기본 Wrangler 프로필과 별개다. 계정 연결 후 사용할 프로필 위치를 일관되게 유지한다.

## 3. Supabase DB 적용

현재 프로젝트 `oxaggbmvughcdxsuhlpd`는 `SJPadlet` Free 조직의 서울 리전에 있다. 이 프로젝트에는 MCP를 통해 초기 SQL과 `moa_migrations` 체크섬 기록이 이미 적용됐다. 앱 테이블 RLS·직접 클라이언트 권한 회수·비공개 버킷·Realtime 정책/트리거를 원격 쿼리로 확인했다. 아래 CLI 절차는 새 프로젝트 또는 체크섬 확인에 사용하며 같은 초기 SQL을 수동으로 반복 적용하지 않는다.

DB 접속 주소는 Supabase Connect에서 얻는다. DB 마이그레이션에만 쓸 `DATABASE_URL`을 Git에서 제외된 `.env.free`에 저장한다. 인증서 검증을 끄지 않는다. Node에서 전용 DB에 접속 가능한 환경에서 실행한다.

```sh
npm ci
npm run db:migrate:free
```

후속 버전 `202610120002_classroom_followups.sql`은 초안·교사 허용 명단·섹션 삭제·게시판 외형·운영 기록 테이블과 비공개 `school-backups` 버킷(파일당 12MB)을 추가한다. 이 버전을 적용하기 전에 새 Worker를 배포하면 게시판 조회가 실패하므로 `npm run db:migrate:free` → `npm run deploy:free` 순서를 지킨다.

자동 백업은 선택 사항이다. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`로 만든 키를 `npx wrangler secret put BACKUP_ENCRYPTION_KEY`로 등록하고, 같은 키를 학교 밖 안전한 곳에 따로 보관한다. 키가 없으면 매일 Cron은 정리만 실행하고 학교 관리 화면에 백업 미설정이 표시된다. 운영 복원은 관리자 화면의 미리보기·확인 문구 절차로만 수행한다.

생성된 `supabase/migrations/202610120001_free_hosting.sql`은 앱 테이블·권한 회수·비공개 버킷·Realtime 정책과 트리거를 포함한다. 스크립트는 적용 버전과 체크섬을 기록하고 한 트랜잭션으로 적용한다. 재실행은 같은 체크섬이면 건너뛴다. 이미 적용한 파일을 고치지 말고 후속 버전을 추가한다. 이 초기 파일은 `npm run db:generate:free`로 스키마와 `supabase/security.sql`에서 생성한다.

## 4. Hyperdrive 연결

Cloudflare에서 Supabase DB를 가리키는 Hyperdrive를 만든다. 연결 정보는 대시보드의 비밀 입력란을 사용한다. **Query caching은 Disabled로 설정해야 한다.** 캐시가 켜지면 세션·공유 회수·승인 상태가 오래된 결과로 반환될 수 있다. `deploy:free`가 원격 Hyperdrive 설정을 조회해 캐시 비활성 상태를 확인한다.

Hyperdrive는 연결 풀만 사용한다. [Supabase 연결 가이드](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/), [권한 조회와 캐시 설정](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

`wrangler.jsonc`의 `account_id`, `APP_URL`, 교사/관리자 명단은 현재 연결된 계정과 사용자 지시를 반영했다. Hyperdrive ID, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`는 실제 값을 넣어야 한다. 비밀키나 DB 암호는 이 파일에 넣지 않는다. 나머지 placeholder가 있으면 배포가 중단되며 자동 리소스 생성은 하지 않는다.

재개 후 `SUPABASE_URL`과 publishable key도 확인된 프로젝트 값으로 반영했다. 현재 Hyperdrive ID는 생성된 실제 리소스 값이며 placeholder가 아니다.

### 서버 비밀값 입력 위치

프로젝트 상단 **Connect → Session pooler → URI**에서 DB 주소를 복사한다. `[YOUR-PASSWORD]`는 이 프로젝트를 만들 때 정한 DB 비밀번호로 바꿔 `.env.free`의 `DATABASE_URL=`에 저장한다. API secret과 DB 비밀번호는 서로 다른 값이다. 비밀번호에 URL 특수문자가 있으면 해당 비밀번호 부분을 URL 인코딩해야 한다. 인증서 검증을 끄는 옵션은 사용하지 않는다.

[Settings → API Keys](https://supabase.com/dashboard/project/oxaggbmvughcdxsuhlpd/settings/api-keys)의 **Secret keys**에서 서버용 `sb_secret_…` 값을 복사해 `.env.free`의 `SUPABASE_SECRET_KEY=`에 저장한다. publishable key는 이미 입력했다. 두 비밀값은 채팅·Git에 넣지 않는다. [DB 연결 가이드](https://supabase.com/docs/guides/database/connecting-to-postgres), [API 키 종류](https://supabase.com/docs/guides/getting-started/api-keys).

## 5. 실시간 서명 키와 Worker secrets

```sh
npm run cf:realtime-key
```

Git에서 제외된 `.data/realtime-signing.jwk`를 0600 권한으로 생성하며 기존 파일을 덮어쓰지 않는다. 이 개인키를 Supabase JWT Signing Keys에서 import한 뒤 activate/rotate한다. 같은 `kid`와 개인키가 Worker에서도 사용되어야 한다. 키 변경 전 이미 사용하는 프로젝트인지 확인한다. [공식 키 가져오기 절차](https://supabase.com/docs/guides/auth/signing-keys).

프로젝트 Wrangler를 이용해 다음 값을 비밀 입력으로 설정한다. 명령 인수에 값 자체를 넣지 않는다.

```sh
npm exec -- wrangler secret put GOOGLE_CLIENT_ID
npm exec -- wrangler secret put GOOGLE_CLIENT_SECRET
npm exec -- wrangler secret put SUPABASE_SECRET_KEY
npm exec -- wrangler secret put SUPABASE_SIGNING_JWK
```

### 짧은 주소 `sjmoa.pages.dev`

공유 링크·QR·프로젝터 안내는 `SHARE_URL`(`https://sjmoa.pages.dev`)로 표시한다. `apps/short-url/_worker.js`가 Cloudflare Pages(무료)에서 같은 경로와 쿼리를 `APP_URL`로 302 전달한다. 로그인·세션·권한은 모두 기존 주소에서 처리하고 짧은 주소는 GET/HEAD 전달만 한다. 초대 토큰(43자)은 추측 방지를 위해 줄이지 않으며, 말로 전할 때는 `sjmoa.pages.dev/join` + 10자리 참여 코드를 쓴다.

최초 1회 일반 터미널에서 Pages 프로젝트를 만들고 배포한다. **짧은 주소를 먼저 배포한 뒤** `SHARE_URL`이 들어간 Worker를 배포해야 링크가 끊기지 않는다.

```sh
npx wrangler pages project create sjmoa --production-branch main
npm run deploy:short
curl -sI https://sjmoa.pages.dev/join | grep -i location   # https://samjeong-moa.samjeong-moa.workers.dev/join
npm run deploy:free
```

`sjmoa` 이름이 이미 사용 중이면 생성이 실패한다. 다른 이름을 쓰면 `package.json`의 `deploy:short`와 `wrangler.jsonc`의 `SHARE_URL`을 함께 바꾼다. 서비스 주소가 바뀌면 `_worker.js`의 목적지도 바꿔야 하며 테스트가 `APP_URL`과의 불일치를 잡는다.

### 교사 Google 그룹 (선택)

학생도 같은 도메인을 쓰므로 교사는 명단 또는 그룹 멤버십으로만 결정한다. 교사 그룹을 쓰려면 Workspace 최고 관리자가 다음을 설정한다.

1. OAuth 클라이언트와 같은 Google Cloud 프로젝트에서 **Admin SDK API**를 사용 설정하고 서비스 계정과 JSON 키를 만든다. 조직 정책이 키 생성을 막으면 그 프로젝트에만 예외를 둔다.
2. 관리 콘솔 → 보안 → API 제어 → **도메인 전체 위임**에 서비스 계정의 클라이언트 ID를 추가하고 범위는 `https://www.googleapis.com/auth/admin.directory.group.member.readonly` **하나만** 허용한다.
3. `wrangler.jsonc` vars에 `TEACHER_GROUP_EMAIL`(교사 그룹 주소)과 `GOOGLE_DIRECTORY_SUBJECT`(위임 대상 관리자 계정)를 넣고, 키는 `npx wrangler secret put GOOGLE_DIRECTORY_KEY`로 JSON 전체를 등록한다. 키 파일은 저장소·`.env.free`에 두지 않고 등록 후 삭제한다.

판단 순서: 운영 관리자 → 학교 관리 화면의 허용/해제(최우선) → `TEACHER_EMAILS` → 교사 그룹 멤버 → 학생. 그룹 조회 실패 시 교사 로그인은 503으로 거부하고(학생 강등 없음) 학생 로그인은 그대로 허용한다. 매일 Cron이 그룹으로만 교사가 된 계정을 다시 확인해 그룹에서 빠진 계정을 학생으로 바꾸고 세션을 끊는다. 조회가 실패한 날은 아무도 강등하지 않는다.

Google 웹 OAuth 클라이언트의 리디렉션 주소는 `<APP_URL>/api/auth/google/callback`이다. `TEACHER_ADMISSION=allowlist`와 실제 교사 명단을 유지한다. `ADMIN_EMAILS` 계정도 `@samjeong.ms.kr`와 Google Workspace `hd`가 검증되어야 한다. 학생 로그인은 교사 도메인과 별도이며, 유효한 초대를 요구한다.

### Google OAuth 생성 순서

1. [Google Cloud Console](https://console.cloud.google.com/)에서 이 앱의 프로젝트를 선택하거나 만든다.
2. **Google 인증 플랫폼(Google Auth Platform) → 시작하기/Get started**에서 앱 이름 `모아 · 삼정중학교`, 지원 이메일, 개발자 연락 이메일을 설정한다. 이미 초기 설정했다면 Branding에서 확인한다.
3. **대상/Audience**의 사용자 유형은 **외부/External**로 설정한다. 학교 밖 Google 계정을 쓰는 학생도 로그인할 수 있어야 하기 때문이다. 교사 도메인과 명단 제한은 앱 서버에서 별도로 검사한다. 우선 테스트 상태로 설정한다.
4. **데이터 액세스/Data Access**에는 기본 로그인 범위 `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`만 사용한다. 앱도 이 세 범위만 요청한다.
5. **클라이언트/Clients → 클라이언트 만들기/Create client → 웹 애플리케이션/Web application**을 선택하고 이름을 `모아 웹`으로 설정한다. 승인된 리디렉션 URI에 아래 주소를 정확히 입력한다.

```text
https://samjeong-moa.samjeong-moa.workers.dev/api/auth/google/callback
```

이 서버 로그인 흐름은 JavaScript 원본 등록을 필수로 사용하지 않는다. 원본을 입력한다면 경로 없이 `https://samjeong-moa.samjeong-moa.workers.dev`를 입력한다. 로컬 Next.js 개발까지 확인하려는 경우 별도 리디렉션 `http://localhost:3000/api/auth/google/callback`을 추가할 수 있다.

6. 생성 직후 클라이언트 ID와 secret을 안전하게 저장한다. 프로젝트에 생성한 Git 제외 파일 `.env.free`의 `GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`에 입력한다. 이 파일에 입력하는 것만으로 원격 Worker에 자동 등록되는 것은 아니며, 실제 배포 때 Worker secrets로 별도 등록해야 한다. secret은 채팅·Git·명령 인수에 넣지 않는다.

Google의 기본 이름/이메일/프로필 로그인만 요청하는 앱은 테스트 사용자 등록·7일 만료 규칙의 예외가 적용된다. 다른 API 범위를 추가하면 이 예외가 사라질 수 있다. 학교 Workspace에서 외부 앱을 차단했다면 학교 관리자의 허용 설정도 필요하다. [Google Audience 공식 안내](https://support.google.com/cloud/answer/15549945?hl=en), [웹 OAuth 클라이언트와 정확한 리디렉션 주소](https://developers.google.com/identity/protocols/oauth2/web-server).

Supabase Realtime 설정은 private 채널만 허용하는 옵션을 활성화한다. 메시지 RLS는 서명된 `moa_topic`과 요청 채널을 일치시키며, 앱/Storage 직접 읽기 권한은 JWT에 부여하지 않는다. [Realtime 권한 캐시와 만료](https://supabase.com/docs/guides/realtime/authorization).

## 6. 검증과 배포

### 현재 준비된 프로젝트의 최초 배포

Cloudflare 계정 이메일 인증을 먼저 완료한다. 오류 10034가 나오면 Cloudflare **My Profile → Email Address → Send verification email**에서 이메일을 받고 링크로 인증한다. 현재 계정 이메일은 `kms99082248@gmail.com`이며 학교 로그인 계정과 별개다. [공식 이메일 인증 안내](https://developers.cloudflare.com/fundamentals/user-profiles/verify-email-address/). 인증 완료 후 아래 설정 명령을 재실행한다. 이미 생성한 Hyperdrive는 재사용한다.

Google·DB·Storage 입력과 서명 키 등록을 끝냈다면 일반 터미널에서 다음을 실행한다. CLI 로그인은 현재 실행 환경에서 콜백 포트를 열 수 없어 사용자의 일반 터미널에서 진행해야 한다.

```sh
cd /Users/minsu/dev/padlet
npm run cf:login
npm run deploy:setup
```

`deploy:setup`은 `.env.free`와 `.data/realtime-signing.jwk`를 읽는다. 키를 다시 복사하거나 비밀번호를 명령 인수로 전달하지 않는다. Cloudflare 계정, Supabase 공개 JWKS의 키 ID/공개키 일치, 서버 키로 접근한 비공개 버킷/1MB 한도를 확인한다. 다른 프로젝트 DB 주소와 예시 비밀번호는 거부한다.

이후 `samjeong-moa-db` Hyperdrive를 캐시 비활성·원본 연결 5개로 생성한다. 기본 TLS는 WebPKI 인증서를 검증한다. 이름이 같은 기존 리소스는 대상 DB와 캐시 설정이 일치할 때만 재사용하고 자동으로 변경하지 않는다. 실제 ID를 `wrangler.jsonc`에 기록한다. 플랜 변경·결제·유료 도메인 생성 API는 호출하지 않는다.

전체 검사 후 필요한 Worker secrets 네 개만 0600 권한의 Git 제외 임시 파일로 묶어 `wrangler deploy --secrets-file`에 전달한다. DB 암호와 Cloudflare 인증 토큰은 이 파일에 포함하지 않는다. 성공/오류 종료 시 임시 파일을 삭제한다. 배포 후 상태 API와 DB를 사용하는 Google 로그인 시작 리디렉션을 확인하지만 학교 계정의 로그인 완료·학생 QR·실시간 활동 검증은 별도다.

`npm run deploy:setup -- --validate-only`는 외부 전송/변경 없이 로컬 설정만 확인한다. 사용자 일반 터미널에서는 인증/Hyperdrive 생성이 진행됐고 Worker 배포는 이메일 인증에서 막혔다. 이 대화 환경의 직접 API 호출은 DNS 오류로 중단된다. 스크립트는 고정된 실패 단계와 제한된 네트워크 오류 코드만 추가 출력하고 원격 응답/비밀값은 출력하지 않는다. [인증 토큰의 안전한 스크립트 사용](https://developers.cloudflare.com/workers/wrangler/commands/general/#auth-token), [코드와 secret 동시 배포](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code), [Hyperdrive TLS](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/).

### 이미 연결된 리소스에 재배포

```sh
npm run cf:types
npm run check
npm run deploy:free
```

`deploy:free`는 placeholder와 필수 설정을 먼저 검사한다. 이어 전체 검사, 원격 Hyperdrive 캐시 설정, 필수 secret 이름을 확인한 뒤 정적 화면과 Worker를 배포한다. 최초 설정 스크립트에서 secret 파일을 전달하면 기존 Worker가 없어도 필수 secret을 함께 배포한다. 원격 설정 조회 결과 전체나 비밀값을 로그에 출력하지 않는다. 현재 배포된 리소스에는 CLI 인증이 있는 일반 터미널에서 재배포할 수 있다. `cf:dry-run` 성공은 패키지 검증이며 원격 DB·Storage·Realtime·실제 로그인 검증은 아니다.

`check`에 포함된 `cf:smoke`는 생성된 번들을 실제 workerd 엔진에서 불러와 상태 API·정적 파일 라우팅·무료 업로드 제한·교차 출처 요청 차단을 검사한다. 소켓을 열거나 원격 DB에 연결하지 않는다. 브라우저 및 외부 서비스 통합 검증과는 별개다.

배포 후 `GET /api/health`, 학교 교사 로그인·일반 학생 Google 로그인·익명 QR 참여·승인 전 답안 비공개·사진 표시·댓글·공유 회수·비공개 다운로드 거부를 확인한다. 로그아웃·회수·교사 정지 후 열린 화면도 확인한다. 휴대전화 QR·인쇄·키보드·학교망 40명 부하와 Worker CPU·쿼리·전송량을 실측한 뒤 수업에 사용한다. 지금은 실환경 수업 검증을 완료하지 않았다.

## 백업과 휴면

Supabase Free에는 자동 백업이 없다. 직접 DB 접속 환경에서 기존 `db:backup`/`db:restore` 스크립트를 사용할 수 있지만 업로드 이미지 원본은 버킷에서 별도 백업해야 한다. DB 백업만으로 이미지가 복구되지는 않는다. 실제 복원은 운영 데이터 교체이므로 대상을 확인한다.

Supabase Free는 1주일간 비활성 시 일시 중지될 수 있다. 방학 후 수업 전에 프로젝트 상태를 확인하고 필요하면 재개한다. 가짜 트래픽으로 휴면 정책을 우회하는 작업은 추가하지 않았다.

## UI 수정본 반영 확인

일반 터미널에서 `npm run deploy:free`를 실행한 뒤 [릴리스 확인](https://samjeong-moa.samjeong-moa.workers.dev/release.json)을 연다. 두 번째 UI 개선은 `{"release":"2026-10-12-ui2"}`를 반환해야 한다. 이전 버전에서는 이 파일이 없으므로 SPA 화면이 표시될 수 있다. 배포 시각만으로 최신 화면 파일의 반영을 단정하지 않는다. 학교명·교사 홈·한 줄 게시판 도구·섹션 입력·설정/작성 창도 실제 화면에서 확인한다.
