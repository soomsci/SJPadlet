# 모아 · 삼정학교 협업보드

학교 교사는 `@samjeong.ms.kr` Google 계정으로 게시판을 만들고, 학생은 Google 로그인 또는 익명으로 참여하는 웹서비스다. 현재는 병렬 개발한 **P0 첫 통합 구현**이며, 학교 운영 배포 전 검증이 남아 있다.

## 로컬 실행

Node.js 24 이상을 권장한다.

```sh
npm ci
cp .env.example apps/web/.env.local
npm run dev
```

`http://localhost:3000`에서 교사 로그인 화면을 연다. Google 설정이 없을 때는 `데모 교사로 체험`으로 게시판을 만들 수 있다. 데모는 개발 모드·localhost·명시적 환경 설정에서만 허용되며 운영에서는 사용할 수 없다. 별도 브라우저/시크릿 창으로 공유 링크에 접속하면 익명 학생 흐름을 확인할 수 있다.

개발 데이터는 프로젝트 `.data/postgres`, 파일은 `.data/uploads`에 저장한다. 개발용 PGlite와 운영용 PostgreSQL이 동일 SQL 스키마를 사용한다. 개발 서버는 단일 프로세스로 실행한다. 로컬 QR에 들어가는 localhost 주소는 다른 기기의 주소가 아니므로 휴대전화 공유는 실제 서비스 주소를 설정한 환경에서 확인한다.

## Google 로그인 설정

`apps/web/.env.local` 또는 운영 환경에 다음 값을 설정한다.

- `APP_URL`: 실제 서비스의 origin. 변경 API의 Origin과 프로토콜·호스트·포트가 정확히 일치해야 한다.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: Google 웹 OAuth 클라이언트. 승인된 리디렉션 URI는 `<APP_URL>/api/auth/google/callback`.
- `TEACHER_EMAILS`: 로그인할 교사 이메일을 쉼표로 구분. 기본 `TEACHER_ADMISSION=allowlist`.
- `ADMIN_EMAILS`: 학교 관리자 이메일. 관리자도 검증된 학교 도메인 계정이어야 한다.
- `TEACHER_ADMISSION=domain`: 학교 도메인이 교사 전용임을 확인한 환경에서만 자동 교사 등록.

학생 Google 계정에는 교사 도메인 조건을 적용하지 않는다. 학생은 로그인 이후에도 유효한 초대가 있어야 게시판에 접근한다. Google OAuth 콜백은 state·nonce·PKCE로 요청을 검증한다. 익명 글을 계정에 연결하는 동작은 사용자가 명시적으로 선택한다.

## 구현한 흐름

- 교사 홈·검색·즐겨찾기·휴지통, 게시판 생성·설정·복제·개방·종료
- 벽·격자·열 배치, 섹션, 게시글·파일·링크·댓글·좋아요·교사 승인·순서 변경
- 학생 로그인/익명 참여, 본인 글 수정, 제출 전용 권한, 교사 참여 세션 차단
- 게시판·게시글·섹션·제출 페이지 QR, 링크·코드·PNG·전체 화면·인쇄·만료·회수
- 서버 권한을 확인하는 파일 다운로드와 실시간 변경 알림, CSV·인쇄/PDF
- 관리자 교사 활성/정지·사용량·운영 기록·소유권 이전

기능별 구현 상태와 미완료 범위는 [개발 상태](docs/STATUS.md)를 따른다. UI에 표시되는 익명 참여자 수는 실제 사람 수와 같다고 보장하지 않는다.

## 검사와 백업

```sh
npm run typecheck
npm run lint
npm test
npm run build
# 위 네 검사를 순차 실행
npm run check
npm run db:backup
# 현재 DB 전체를 백업 내용으로 교체하므로 복원 대상 환경을 확인한 뒤 실행
npm run db:restore -- .data/backups/<backup.json> --confirm-replace
```

백업은 DB 내용 전체를 포함하므로 비공개로 보관한다. 업로드 디렉터리는 별도 백업·복원이 필요하다. 운영 DB의 접속 환경변수는 스크립트 실행 환경에도 전달해야 한다. 자동 백업 예약과 운영 환경의 복구 훈련은 배포 단계에서 구성한다.

## 운영 환경

`DATABASE_URL` PostgreSQL과 HTTPS `APP_URL`이 필요하다. `npm run build` 후 `npm start` 또는 Dockerfile로 실행한다. 업로드 파일 저장소는 재배포 후에도 유지되는 비공개 볼륨을 연결하고 `UPLOAD_PATH`를 설정한다. 운영 파일은 `CLAMAV_HOST`·`CLAMAV_PORT`로 바이러스 검사 서비스를 연결해야 게시할 수 있다. 검사 서비스가 없거나 실패하면 격리 상태로 유지되어 공개되지 않는다.

현재 실시간 알림은 PostgreSQL outbox를 읽는 SSE 방식이며 약 1초 간격으로 권한을 재확인한다. 데이터 본문은 이벤트로 보내지 않고 권한 검사된 API에서 다시 읽는다. 여러 인스턴스·학교 전체 부하·장기 운영에 대한 검증과 백그라운드 정리 작업은 남아 있다. 배포할 때 운영용 비밀값과 OAuth 설정을 직접 제공해야 한다.

## 프로젝트 문서

- [PRD](docs/PRD.md)
- [제작 지침](docs/IMPLEMENTATION.md)
- [병렬 개발 계획](docs/PARALLEL_PLAN.md)
- [공통 실행 계약](docs/DEV_CONTRACT.md)
- [개발 상태·검증 범위](docs/STATUS.md)
- [에이전트 작업 지침](AGENTS.md)

Padlet의 공개 기능을 참고하는 자체 서비스이며, 전체 기능 대응은 후속 P1~P3 작업을 포함한다.
