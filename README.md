# 모아 · 삼정중학교 협업보드

학교 교사는 `@samjeong.ms.kr` Google 계정으로 게시판을 만들고, 학생은 Google 로그인 또는 익명으로 참여한다. 게시판·글·섹션·제출 페이지를 QR로 공유할 수 있다. **Cloudflare + Supabase 무료 시범 배포**와 첫 학교 관리자 계정 로그인까지 확인했다. 학생 참여·실시간·사진·학교망 수업 검증은 남아 있다.

서비스 주소: [모아 · 삼정중학교 협업보드](https://samjeong-moa.samjeong-moa.workers.dev/). 현재 교사는 서버 허용 명단으로 제한하며 학생은 교사의 유효한 초대를 통해 참여한다.

## 무료 배포 구조

Cloudflare 정적 Assets에서 화면을 제공하고 같은 주소의 Worker에서 API를 실행한다. Supabase PostgreSQL·비공개 Storage·Realtime을 사용한다. Google OIDC와 서버 세션, 학교 교사 명단·초대·익명 소유권 검사는 유지한다. API는 Hyperdrive의 캐시를 끈 DB 연결을 사용한다.

사진은 자동 압축하며 업로드 결과는 1MB 이하, 학교 전체 800MB·교사 200MB·게시판 100MB로 제한한다. 문서·영상은 참고 링크로 공유한다. 일반 파일의 백신 검사는 무료 구성에 포함하지 않는다. 무료 사업자의 전송량·동시 연결·CPU 한도와 휴면 정책을 고려해 한두 학급부터 검증한다.

[무료 배포 절차와 필요한 설정](docs/DEPLOY_FREE.md)을 따른다. 현재 `wrangler.jsonc`에는 실제 계정/Hyperdrive와 공개 설정이 들어 있고 비밀값은 Git에서 제외된다. 다른 계정으로 배포할 때는 대상 리소스를 변경해야 한다. 실제 연결이 없으면 배포 스크립트가 중단된다.

```sh
npm ci
npm run cf:types
npm run check
# 전용 Supabase DB와 계정/비밀값 설정 후
npm run db:migrate:free
npm run deploy:short   # 짧은 주소 sjmoa.pages.dev (최초 1회는 Pages 프로젝트 생성 필요)
npm run deploy:free
```

`db:migrate:free`는 `supabase/migrations`의 버전 파일을 순서대로 체크섬과 함께 한 트랜잭션으로 적용한다. 새 버전의 Worker가 새 열·테이블을 사용하므로 **마이그레이션을 먼저 적용한 뒤 배포**한다. 매일 03:00(KST) Cron이 자동 정리와, `BACKUP_ENCRYPTION_KEY` secret이 있으면 암호화 백업을 실행한다. 백업 이미지 묶음 보관은 `npm run ops:archive -- export --backup <백업 ID> --out <새 폴더>`로 확인 후 `--apply`를 붙여 실행한다.

최초 배포에서 `.env.free` 입력과 Supabase 서명 키 가져오기/활성화를 완료했다면 일반 터미널에서 `npm run cf:login` 후 `npm run deploy:setup`을 실행한다. 이 명령은 설정/원격 키/비공개 버킷을 확인하고 캐시를 끈 Hyperdrive를 생성하거나 동일 대상을 재사용한다. 이어 전체 검사와 Worker/정적 파일/필수 secrets 배포, 상태 API와 DB를 사용하는 Google 로그인 시작을 확인한다. 비밀값은 Git 제외 임시 파일로 전달하고 종료 시 삭제한다. `npm run deploy:setup -- --validate-only`는 외부 변경 없이 로컬 설정만 검사한다.

`npm run build`는 정적 화면, `cf:dry-run`은 Worker 패키지를 생성한다. `npm run dev`는 구성된 Worker/Assets를 로컬에서 실행하며 `.dev.vars.example`을 참고한다. local Hyperdrive 연결은 개발 전용 DB를 사용한다. `DATABASE_URL`만 설정해도 Worker가 연결되는 구조가 아니며 Hyperdrive 바인딩이 필요하다. 운영 DB를 로컬 테스트 대상으로 사용하지 않는다.

## 계정 없이 로컬에서 확인

Node.js 24 이상을 권장한다. 기존 Next.js + PGlite 개발 환경도 유지했다.

```sh
npm ci
cp .env.example apps/web/.env.local
npm run dev:node
```

`http://localhost:3000`에서 `데모 교사로 체험`을 사용할 수 있다. 데모는 개발 모드·localhost·명시적 환경 설정에서만 허용되며 Cloudflare Worker는 항상 이를 비활성화한다. 개발 데이터는 `.data/postgres`, 첨부는 `.data/uploads`다. 별도 브라우저로 공유 링크에 접속하면 익명 참여를 확인할 수 있다. localhost QR은 다른 기기에서 열리지 않으므로 휴대전화 검증은 실제 서비스 주소에서 수행한다.

Next.js 컨테이너 방식은 `npm run build:node`, `npm run start:node`와 Dockerfile로 남겨 두었다. 이 방식의 일반 파일 업로드에는 영속 볼륨과 ClamAV가 필요하며 무료 배포 경로와 다르다. 학교 PC 한 대로 운영하는 구성(PostgreSQL·ClamAV·Caddy HTTPS·매일 정리·백업)은 `deploy/selfhost/`에 있고, 설치·운영 절차는 [자체 서버 안내](docs/SELF_HOST.md)를 따른다. 매일 정리 작업만 따로 실행하려면 `node --import tsx scripts/maintenance.ts`.

## 권한과 공유

Google 로그인의 승인된 리디렉션은 `<APP_URL>/api/auth/google/callback`이다. 학교 교사 자격은 검증된 이메일·Workspace `hd`·교사 허용 명단으로 판단하며, 첫 관리자는 `ADMIN_EMAILS`에 명시한다. 학생 계정에는 학교 교사 도메인 조건을 적용하지 않으며 로그인 후에도 유효한 초대를 요구한다. 공유 회수는 기존 참여 권한과 파일 접근도 철회한다. 익명 글은 같은 참여 세션에서 수정하며 명시적인 계정 연결도 지원한다.

## 구현과 검증

교사 홈·검색·즐겨찾기·휴지통, 벽/격자/열·섹션, 글·댓글·좋아요·승인·차단, 대상별 QR·코드·만료·회수, CSV·인쇄/PDF, 관리자 기능이 구현되어 있다. 전체 Padlet 기능 대응은 P1~P3 후속 작업을 포함한다.

`npm run check`는 웹/Worker 타입 검사·린트·테스트·정적 빌드·Worker dry-run·workerd 실행 검증을 실행한다. `cf:smoke`는 생성된 Worker의 상태 API·정적 경로·업로드 제한·교차 출처 차단을 포트 없이 확인한다. 실제 Supabase·Google·Cloudflare 계정 연결과 브라우저/학교망 검증을 대체하지 않는다. DB 백업은 `npm run db:backup`, 복원은 `npm run db:restore -- <backup.json> --confirm-replace`이며 이미지 원본은 별도 백업한다.

- [PRD](docs/PRD.md)
- [제작 지침](docs/IMPLEMENTATION.md)
- [무료 배포](docs/DEPLOY_FREE.md)
- [병렬 개발 계획](docs/PARALLEL_PLAN.md)
- [공통 계약](docs/DEV_CONTRACT.md)
- [구현 상태와 한계](docs/STATUS.md)
- [작업 지침](AGENTS.md)
