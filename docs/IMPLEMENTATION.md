# 제작 지침 및 기술 설계

2026-10-12 / 기본 설계. 첫 통합 구현의 구체적 차이와 잔여 작업은 STATUS.md를 따른다. 사용자의 무료 운영 결정에 따라 Cloudflare + Supabase 구성을 기본으로 한다. 구체적인 배포와 한도는 DEPLOY_FREE.md를 따른다.

## 1. 권장 구조

TypeScript 단일 저장소에 Vite 정적 웹·Cloudflare Worker API, Supabase PostgreSQL·비공개 Storage·Realtime을 둔다. 기존 React 화면과 공통 서버 권한 코드를 재사용한다. 관계형 데이터와 트랜잭션으로 게시판 소유권·공동 교사·학생 참여·공유 범위를 유지한다. Hyperdrive는 캐시를 끈 연결 풀로 사용하고 Worker 요청마다 새 pg.Client를 만든다. 환경값·DB는 AsyncLocalStorage 요청 컨텍스트에 한정한다. DB DDL은 배포 전 버전 마이그레이션으로 적용한다.

Supabase 브라우저 키로 앱 테이블·파일을 직접 읽지 못하게 한다. 파일은 Worker의 최신 권한 검사 후 스트리밍한다. 무료 구성은 1MB 이하 래스터 이미지와 링크 공유로 시작하며 일반 문서용 ClamAV를 실행하지 않는다. Supabase Realtime private 채널에는 빈 변경 알림만 전달한다. 서버가 게시판 접근을 확인한 후 ES256의 60초 JWT를 발급하며 클라이언트는 45초마다 재확인한다. 게시글·댓글·작성자 정보는 알림으로 보내지 않는다. P2 그림 공동 편집은 별도 프로토콜로 설계한다.

기존 Next.js/PGlite와 Node SSE는 오프라인 개발 및 별도 컨테이너 실행 경로로 유지한다. 해당 모드는 무료 운영 아키텍처와 구분하며 일반 문서 파일은 영속 저장소와 백신 검사가 필요하다. 기존 상세 설계 중 확장 목표와 실제 무료 배포의 차이는 DEPLOY_FREE.md와 STATUS.md가 우선한다.

인증은 검증된 Google OIDC 라이브러리와 서버 세션을 사용한다. QR 생성은 클라이언트 로컬 라이브러리로 처리하여 공유 링크를 외부 QR 서비스로 보내지 않는다. 라이브러리와 프레임워크의 실제 버전은 구현 시작 시 호환성을 확인해 잠금 파일에 고정한다.

## 2. 인증·권한 계약

Google ID 토큰의 서명·issuer·audience·만료·nonce를 서버에서 검증한다. 사용자 식별키는 이메일이 아닌 Google `sub`다. 교사 자격은 `email_verified`, 이메일 도메인의 정확한 일치, Workspace `hd`의 허용값, 학교 회원 상태를 함께 확인한다. 로그인 화면의 `hd` 옵션은 힌트일 뿐 권한 검증이 아니다. 도메인 별칭이 있다면 학교가 확인한 매핑을 서버 설정에 명시하고 검증을 생략하지 않는다. [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), [클레임 정의](https://developers.google.com/identity/openid-connect/reference).

교사 전용 도메인 여부 확인 전 운영 기본 설정은 `teacherAdmission=allowlist`로 둔다. 교사 전용이 확인되면 `domain` 자동 등록 모드를 활성화한다. 첫 관리자는 서버 운영 설정으로 명시적으로 지정하며 최초 가입자를 자동 관리자로 만들지 않는다. 학생 로그인에는 학교 교사 도메인 조건을 적용하지 않고 역할을 `student`로 부여한다. 허용되지 않은 교사 로그인 시도는 교사 기능을 거부하되 학생 참여 흐름은 별도로 안내한다.

익명 참여 시 임의의 내부 principal과 서버 세션을 발급한다. 쿠키는 Secure·HttpOnly·SameSite 정책을 적용하며 변경 요청에는 CSRF 방어를 적용한다. 역할·작성자·게시판 권한을 요청 본문에서 신뢰하지 않는다. OAuth 복귀 주소는 서비스 내부 허용 경로만 허용하고 원래 초대 상태를 서버에 연결한다.

익명에서 로그인으로 전환할 때에는 기존 세션 소유 증명과 새 Google 인증을 모두 확인한 명시적 연결 작업으로 본인 글을 이전한다. 닉네임·이메일 문자열 일치만으로 연결하지 않는다. 로그인 실패·취소 시 기존 익명 글은 보존한다.

모든 API와 파일·내보내기·실시간 연결은 공통 `authorize(principal, action, resource)`를 사용한다. 화면에서 버튼을 숨기는 것은 권한 검사가 아니다. DB 접근은 서버 데이터 계층으로 제한한다. [Next.js 인증·인가 가이드](https://nextjs.org/docs/app/guides/authentication).

## 3. 주요 데이터 모델

모든 주요 레코드는 임의 ID, createdAt·updatedAt, 필요한 경우 version·deletedAt을 가진다. 시각은 UTC 저장, 화면과 내보내기는 Asia/Seoul 기본 표시다.

|테이블|주요 필드·규칙|
|---|---|
|principals|id, kind(account/anonymous), disabledAt|
|accounts|principalId, provider, providerSubject(unique), email, verified, displayName|
|school_members|principalId, schoolId, role(admin/teacher/student), status; 서버만 변경|
|teacher_allowlist|schoolId, email 또는 providerSubject, status|
|sessions|hashedToken, principalId, expiresAt, revokedAt|
|boards|schoolId, ownerId, title, format, lifecycle, participationMode, moderation, version|
|board_members|boardId, principalId, role(owner/editor/reader); 소유 교사 정확히 한 명|
|sections|boardId, title, rank; P0는 별도 접근 경계 아님|
|share_links|tokenHash, targetType, targetId, scope, version, expiresAt, revokedAt, codeHash|
|participations|principalId, boardId, shareLinkId, shareVersion, groupId?, expiresAt, blockedAt|
|posts|boardId, sectionId?, authorId, title, body, status, rank, version|
|comments|postId, authorId, body, status|
|reactions|postId, principalId, type, value; 종류별 중복 방지 unique|
|attachments|postId?, boardId, uploaderId, privateKey, mime, bytes, scanStatus, lifecycle|
|audit_events|actorId, action, target, timestamp, 최소 메타데이터; 원문·인증 토큰 제외|
|outbox_events|eventId, resourceId, eventType, version, createdAt, deliveredAt|
|jobs|type, scope, state, idempotencyKey, resultKey?, expiresAt|

P1 그룹·투표, P2 카드·오브젝트, P3 게임·응답은 별도 마이그레이션으로 추가한다. 초기부터 모든 후속 기능의 스키마를 확정하지 않는다. 학생 응답 DTO에서 authorId·email·내부 차단 정보는 제거하고 게시판별 가명 식별자를 사용한다.

## 4. API 계약 초안

실제 스키마와 OpenAPI는 첫 공통 작업에서 작성한다. 아래 인터페이스는 병렬 작업 분리 기준이다.

|경로|역할|
|---|---|
|`GET /api/me`|세션·역할·허용 행동, 학생에게 교사 정보 미반환|
|`/api/auth/google/*`, `POST /api/auth/logout`|OAuth 시작·콜백·로그아웃|
|`POST /api/join`|공유 토큰/코드 검증, 필요시 익명 세션, 참여 권한 발급|
|`GET/POST /api/boards`|허가된 교사 게시판 목록·생성|
|`GET/PATCH/DELETE /api/boards/:id`|조회·설정·휴지통 이동|
|`GET/POST /api/boards/:id/posts`|권한에 맞춘 목록·작성|
|`PATCH/DELETE /api/posts/:id`|작성자·상태·version 검증|
|`POST /api/posts/:id/comments`, `PUT /api/posts/:id/reaction`|댓글·멱등 반응|
|`POST /api/posts/:id/moderation`|승인·반려·숨김|
|`POST /api/shares`, `POST /api/shares/:id/revoke`|공유 발급·철회|
|`POST /api/attachments/init`, `POST /api/attachments/:id/complete`|허가된 업로드 준비·완료 검증|
|`GET /api/attachments/:id/content`|매 요청 권한 확인 후 파일 전달|
|`GET /api/boards/:id/events`|허용 범위 SSE 연결|
|`POST /api/boards/:id/exports`, `GET /api/jobs/:id`|내보내기·작업 상태|
|`/api/admin/*`|교사 관리·사용량·소유권 이전·감사 로그|

응답은 `{data, meta}` 또는 `{error:{code,message,requestId}}`로 통일한다. 공통 오류는 `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `SHARE_EXPIRED`, `BOARD_CLOSED`, `CONFLICT`, `RATE_LIMITED`, `UPLOAD_REJECTED`다. 존재 자체가 비공개인 대상은 NOT_FOUND로 처리한다. 목록은 커서 페이지네이션, 쓰기는 서버 검증 스키마·길이 제한·멱등 키, 수정은 version 낙관적 잠금을 사용한다. 충돌 시 409와 재조회 안내를 반환한다.

## 5. 공유·실시간·파일 권한

공유 토큰은 암호학적 난수 128비트 이상이며 DB에는 해시만 저장한다. QR은 `/s/:token`, 짧은 코드는 별도 제한된 조회 경로를 쓴다. 원본 토큰은 최초 발급 때 반환하고 이후 재표시가 필요하면 안전한 서버 보관 방식을 명시적으로 설계하거나 링크를 새로 발급한다. QR URL은 분석·서버 로그에서 마스킹하고 Referrer-Policy를 적용한다.

참여는 shareLinkId와 version에 묶는다. 재발급·철회는 기존 version 참여를 무효화한다. 실시간 연결은 시작 시 검증하고 이벤트 전달 전에도 권한을 확인하며 권한 변경 알림으로 연결을 종료한다. 학생이 구독할 수 있는 이벤트에는 공개 글 또는 본인 글만 포함한다. 대기 글 본문을 전체 채널로 전송한 뒤 UI에서 숨기지 않는다.

재연결은 마지막 eventId와 제한된 재생 구간을 사용하고, 누락 가능성이 있으면 허용된 데이터 스냅샷을 다시 읽는다. 클라이언트는 eventId·version으로 중복과 역순 이벤트를 처리한다. 삭제·닫힘 이벤트를 다른 수정이 되살리지 못하게 한다.

파일은 비공개 저장소에 격리 업로드하고 확장자·실제 형식·크기·악성 파일 검사를 통과한 뒤 제공한다. SVG·HTML 등 실행 가능한 콘텐츠는 기본 업로드 거부 또는 안전한 다운로드 전용 처리한다. 서버가 업로드 완료 바이트 수와 소유권을 확인하며 고아 파일을 정리한다. 다운로드는 권한 프록시를 기본으로 하여 공유 회수 후 새 요청을 거부한다. 공개 영구 URL을 생성하지 않는다.

본문은 제한된 리치 텍스트 스키마를 사용하고 임의 HTML은 금지한다. 링크 미리보기는 사설 IP·메타데이터 주소·리다이렉트의 우회를 차단한다. 외부 임베드는 허용 목록·sandbox 정책을 적용한다. CSV는 수식 주입을 방지한다. 학교망의 공용 IP를 고려하여 제한은 세션·게시판 중심으로 적용하고 IP 제한은 보조로 사용한다.

## 6. 화면·디렉터리 경계

```text
apps/web/src/app/             # 통합 담당: 라우트와 기능 연결
apps/web/src/features/auth/   # A: 인증 UI
apps/web/src/features/boards/ # B: 교사 홈·게시판·게시글
apps/web/src/features/join/   # C: 학생 참여
apps/web/src/features/share/  # C: 링크·QR
apps/web/src/features/admin/  # D: 운영 UI
packages/contracts/          # 통합 담당: DTO·검증 스키마·API 계약
packages/ui/                 # 통합 담당: 공통 디자인·접근성
packages/server/auth/        # A
packages/server/policy/      # A: 공통 권한 검사
packages/server/boards/      # B
packages/server/shares/      # C
packages/server/media/       # D
packages/server/realtime/    # D
packages/db/                 # 통합 담당: 스키마·마이그레이션
tests/security/              # A
tests/e2e/                   # D: 통합 사용자 흐름
docs/                        # 통합 담당: 제품·설계·결정 기록
```

위 구조를 기준으로 첫 구현을 생성했다. common·participants·exports 등 통합 모듈이 추가되었으며 단일 작업자가 개발할 때도 같은 경계를 유지한다.

## 7. 검증·운영

권한 행렬, 타인 데이터 접근, QR 범위·회수, 익명 소유권, 승인 상태, 업로드, 세션 연결을 우선 테스트한다. Google 로그인은 로컬 모의 인증과 별도로 스테이징 실제 계정으로 확인한다. 모의 로그인 경로는 운영 빌드에서 사용할 수 없어야 한다.

PR 필수 검사는 타입 검사·린트·관련 단위 및 API 테스트·빌드다. 통합 단계에서 핵심 E2E와 부하·모바일 검증을 수행한다. 운영 배포 전 백업 복원, 스키마 이전, 오류 알림, 비밀값 분리, 롤백 방법을 확인한다. 실행 명령은 README를 따른다. npm run check로 타입·린트·테스트·빌드를 순서대로 검증한다.

운영·스테이징·개발 데이터와 OAuth 콜백 주소를 분리한다. 학교 데이터는 테스트 fixture로 복사하지 않는다. 저장량·트래픽·DB·연결 수·작업 큐 비용의 예산 알림과 업로드 제한을 마련한다. 초기 비용은 사업자·학교 규모가 정해진 뒤 산출한다.

## 8. 완료 정의

기능은 화면 구현, 서버 권한 검증, 오류·빈 상태·모바일 대응, 관련 테스트, 기능 대장 갱신까지 완료해야 끝난다. 목업이나 로컬 저장만 되는 기능을 운영 완료로 표시하지 않는다. 후속 단계 기능은 버튼만 만들어 동작하는 것처럼 보이지 않는다.

## 9. 게시판 UI 개선 계약

[UI_IMPROVEMENTS.md](UI_IMPROVEMENTS.md)를 따른다. UX-01~06에 해당하는 첫 개선은 기존 BoardView/API를 유지한다. 섹션별 작성 버튼은 기존 sectionId를 전달하고, 이름 변경·이동·QR은 기존 서버 경로를 사용한다. 공유의 화면 변경으로 접근 권한을 넓히지 않는다. 작성 가능 여부는 can_write와 대상 범위로 결정한다.

게시판 공통 Dialog는 마운트 시 한 번 입력 필드에 초점을 설정하고, 입력/실시간 갱신으로 새 onClose 함수가 전달돼도 초점을 재설정하지 않는다. effect의 키보드 리스너는 useEffectEvent로 최신 닫기 동작을 호출한다. 한글 조합 Escape, Tab 경계, 닫은 뒤 원래 버튼의 초점 복원을 테스트한다. 초안·발표·섹션 삭제 등 후속 요구는 별도 저장·권한·충돌 계약 후 구현한다.

게시판에서만 BoardChrome 도구 모음을 사용하고 기존 사이트 헤더는 숨긴다. 관리자 링크는 BoardView principal.role=admin일 때 계정 메뉴에서 제공하며 서버 권한 검사를 유지한다. 설정/작성 Dialog variant는 화면 배치만 바꾸며 서버 저장과 업로드 정책은 유지한다. 교사 홈은 분류 사이드바·검색·목록·만들기 중심으로 구성한다. 정적 release.json은 릴리스 확인용이며 프론트엔드 반영 확인과 Worker 배포 시각을 별도로 검증한다.
