# 제작 지침 및 기술 설계

2026-10-12 / 제안 설계. 실제 구현 시작 시 버전·배포 사업자·예산을 확정한다.

## 1. 권장 구조

TypeScript 단일 저장소에 Next.js 웹·서버 API, PostgreSQL, 비공개 객체 저장소, 실시간 전달 서비스, 백그라운드 작업자를 둔다. 관계형 데이터로 게시판 소유권·공동 교사·학생 참여·공유 범위를 표현한다. P0 게시판은 서버가 저장한 변경을 SSE로 전달하고, P2 동시 화이트보드는 별도 동기화 프로토콜을 설계한다. 게시판 이벤트 모델을 그대로 그림 공동 편집에 사용하지 않는다.

웹과 API는 컨테이너 배포를 기본안으로 삼는다. 실시간 연결을 지원하는 호스팅을 선택하고 수평 확장 시 공유 메시지 브로커를 둔다. PostgreSQL outbox에 변경 이벤트를 같은 트랜잭션으로 기록해 저장과 알림의 불일치를 줄인다. 파일 검사·내보내기·백업은 비동기 작업자로 처리한다. 특정 유료 서비스 구매나 배포는 이 문서 작성에 포함하지 않는다.

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

이는 생성 예정 구조이며 아직 존재하는 소스가 아니다. 단일 작업자가 개발할 때도 같은 모듈 경계를 유지한다.

## 7. 검증·운영

권한 행렬, 타인 데이터 접근, QR 범위·회수, 익명 소유권, 승인 상태, 업로드, 세션 연결을 우선 테스트한다. Google 로그인은 로컬 모의 인증과 별도로 스테이징 실제 계정으로 확인한다. 모의 로그인 경로는 운영 빌드에서 사용할 수 없어야 한다.

PR 필수 검사는 타입 검사·린트·관련 단위 및 API 테스트·빌드다. 통합 단계에서 핵심 E2E와 부하·모바일 검증을 수행한다. 운영 배포 전 백업 복원, 스키마 이전, 오류 알림, 비밀값 분리, 롤백 방법을 확인한다. 실제 명령은 프로젝트 초기화 시 등록하고 문서에 동기화한다. 아직 실행 가능한 npm 명령은 없다.

운영·스테이징·개발 데이터와 OAuth 콜백 주소를 분리한다. 학교 데이터는 테스트 fixture로 복사하지 않는다. 저장량·트래픽·DB·연결 수·작업 큐 비용의 예산 알림과 업로드 제한을 마련한다. 초기 비용은 사업자·학교 규모가 정해진 뒤 산출한다.

## 8. 완료 정의

기능은 화면 구현, 서버 권한 검증, 오류·빈 상태·모바일 대응, 관련 테스트, 기능 대장 갱신까지 완료해야 끝난다. 목업이나 로컬 저장만 되는 기능을 운영 완료로 표시하지 않는다. 후속 단계 기능은 버튼만 만들어 동작하는 것처럼 보이지 않는다.
