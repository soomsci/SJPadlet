# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

프로젝트 규칙·목적·보안 원칙은 AGENTS.md가 원본이다. 아래는 그 내용을 반복하지 않고, 코드 구조와 명령만 보충한다.

@AGENTS.md

## 명령

```sh
npm run check            # typecheck → lint → test → build → cf:dry-run → cf:smoke (완료 보고 전 필수)
npm run typecheck        # 루트 tsconfig + apps/worker/tsconfig.json 두 번 실행
npm test                 # vitest, tests/**/*.test.{ts,tsx}
npx vitest run tests/ui/board-workspace.test.tsx        # 파일 하나
npx vitest run tests/boards -t "섹션"                    # 이름으로 필터
npm run dev              # wrangler dev (Worker + 정적 Assets, Hyperdrive 로컬 연결 필요)
npm run dev:node         # Next.js + PGlite 로컬 개발 (계정 없이, 데모 교사 로그인)
npm run db:migrate:free  # supabase/migrations/*.sql 을 순서대로 체크섬 적용 (.env.free 의 DATABASE_URL)
npm run deploy:free      # 사용자 승인 후에만. 반드시 마이그레이션 먼저
```

CI(`.github/workflows/check.yml`)는 typecheck·lint·test·build만 실행한다. Worker dry-run/smoke는 로컬 `npm run check`에서만 돈다. `scripts/smoke-worker.mjs`와 배포 스크립트는 `wrangler.jsonc`를 `JSON.parse`하므로 **이 파일에 주석을 넣으면 안 된다**.

## 구조 (여러 파일을 읽어야 보이는 부분)

**하나의 API, 두 개의 런타임.** 모든 API는 `packages/server/dispatch.ts`의 `dispatch(req, path)`로 들어간다. 각 `handleX(req, path)`는 자기 경로가 아니면 `null`을 반환하고 다음 핸들러로 넘긴다(순서가 의미 있음). 진입점은 두 곳이다.
- 운영: `apps/worker/src/index.ts` — Cloudflare Worker. `/api/*`만 dispatch하고 나머지는 `ASSETS`. `withContext`가 요청(및 `scheduled` Cron)마다 환경값과 Hyperdrive `pg.Client`를 `withRequestContext`(AsyncLocalStorage)에 넣는다. 설정은 `process.env`가 아니라 `setting(name)`(`packages/server/common/runtime.ts`)으로 읽는다.
- Node 개발: `apps/web/src/app/api/[...path]/route.ts` — Next.js가 같은 dispatch를 호출.

**`@db` 별칭이 런타임별로 다르다.** tsconfig/vitest는 `packages/db/index.ts`(PGlite 또는 `DATABASE_URL` Pool, 전역 싱글턴, 시작 시 `schema.ts` 실행)를, `wrangler.jsonc`의 alias는 `packages/db/worker.ts`(요청 컨텍스트의 DB만 사용)를 가리킨다. 트랜잭션은 `db.transaction(async tx => ...)`, 쿼리는 Postgres 문법(`$1`, `FOR UPDATE`, `unnest`)으로 양쪽에서 동일하게 동작해야 한다.

**스키마는 두 곳에서 관리한다.** 테스트/Node 개발은 `packages/db/schema.ts`(`IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`로 멱등)를 쓰고, 운영 Supabase는 `supabase/migrations/`의 버전 파일을 쓴다. 스키마 변경 시 `schema.ts`에 추가하고 **새 버전 마이그레이션 파일**을 만든다. 초기 마이그레이션 `202610120001_free_hosting.sql`은 불변이다(`db:generate:free`는 이미 있으면 실패). 새 테이블은 `supabase/security.sql`과 마이그레이션 양쪽에서 RLS 활성화 + anon/authenticated 권한 회수를 해야 한다(`tests/free/supabase-policy.test.ts`가 검사).

**권한은 `packages/server/policy`에 모인다.** `boardAccess(db, principal, boardId)`가 `can_manage/can_write/submission_only/shares`를 계산하고, `canReadPost/canWritePost`가 글 단위 필터를 한다. 변경 API는 보통 `SELECT ... FOR UPDATE`로 board를 잠근 뒤 `boardAccess`를 다시 계산하고 `version`을 비교(불일치 시 409)한 다음 `emit(tx, boardId, ...)`(outbox → Realtime 빈 알림)과 `audit(...)`을 남긴다. 응답은 보통 권한 필터를 거친 `BoardView`(`getBoardView`) 전체다.

**공통 계약**은 `packages/contracts/index.ts`(타입 + zod 입력 스키마)다. 병렬 작업 시 계약·schema·migration·dispatch·Worker는 통합 담당 소유(`docs/PARALLEL_PLAN.md`, `docs/contracts/FOLLOWUPS.md`).

**프런트엔드도 두 가지 진입점이 같은 화면 코드를 공유한다.** 화면 로직은 `apps/web/src/features/*`. 운영 정적 빌드는 `apps/free-web/src/main.tsx`(Vite, 경로를 직접 매칭하는 단순 라우터 → `dist/web`)이고, Next 페이지(`apps/web/src/app`)는 Node 모드용이다. 새 페이지는 양쪽에 연결해야 한다. 공통 UI/`api()` 헬퍼는 `@ui`(`packages/ui/index.tsx`). 실시간 갱신(`features/live`)은 Supabase Realtime 채널 토큰을 받거나 Node 모드에서는 SSE로 대체되며, 알림을 받으면 권한 API로 다시 조회한다.

**테스트**는 `DATABASE_PATH=memory://` PGlite로 실제 dispatch를 호출하는 서버 테스트와, `// @vitest-environment jsdom` + `fetch`/`api` 모킹을 쓰는 UI 테스트(`tests/ui`, 합성 fixture `board-fixture.ts`)로 나뉜다. `fileParallelism: false`라서 파일들이 전역 DB를 공유하며 순차 실행된다. 테스트는 소스 별칭(`@server/*` 등)을 직접 import한다.

## 상태 문서

구현·검증 기록은 `docs/STATUS.md`, UI 개선 대장은 `docs/UI_IMPROVEMENTS.md`, 배포 절차는 `docs/DEPLOY_FREE.md`. 이 실행 환경에서는 Cloudflare/Supabase API의 DNS 조회가 막혀 있는 경우가 많다. 원격 마이그레이션·배포는 사용자의 일반 터미널에서 실행하도록 안내하고, 실행하지 않은 것은 미검증으로 기록한다.
