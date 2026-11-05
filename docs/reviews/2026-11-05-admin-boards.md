# 관리자 전체 게시판 관리 검토

- 대상: `/admin`의 새 전체 게시판 목록·관리 창. 입력 버전 `b94f06f` 이후 작업 변경.
- Design read: 학교 관리자가 담당 교사와 상태를 보고 게시판을 찾는 운영 화면. 모아의 녹색 토큰·한국어 서체를 유지하며 검색 → 목록 → 선택한 게시판 관리 순서로 구성한다.
- Code-only review; visual verification pending. 로컬 Vite 미리보기 시도는 `listen EPERM 127.0.0.1:5176`으로 실패했다. 브라우저 검수용 서버를 실행하지 못했으며 1440×900·390×844 화면 캡처는 없다.
- 검증: `npm run check` 성공. 26개 파일의 229개 테스트 통과(신규 서버 8·UI 8 포함), 타입·린트·Vite build·Wrangler dry-run·workerd smoke 통과. `git diff --check` 통과.
- UI 테스트는 jsdom에서 검색·상태/소유 교사 필터·휴지통 확인·소유권 이전·복원·버전 충돌 복구·통신 오류/빈 상태·Tab/Escape 초점·늦은 검색 응답 무시를 확인했다. 실제 브라우저 렌더링이나 운영 Google 로그인 검증을 대신하지 않는다.
- 서버 테스트는 관리자/교사/학생/익명·계정 정지·역할 강등·위조·CSRF, 상태/휴지통/소유권, 페이지 경계, QR·대기 글·첨부·CSV·공동 교사 관리와 감사/outbox를 확인했다. 합성 데이터만 사용했다.

## 검토 항목과 근거

SKILL.md의 체크리스트 순서다. `applicable = pass + fail + unverified`.

|번호|상태|근거|
|---|---|---|
|1|pass|관리자 업무에 맞춘 검색·소유 교사·승인 대기 수·관리 버튼: `apps/web/src/features/admin/school-boards.tsx:53` 이후|
|2|N/A|운영 화면이며 hero를 추가하지 않음|
|3|pass|Search/ExternalLink/Settings2는 기존 Lucide 아이콘, 버튼은 텍스트로 이름 제공: `school-boards.tsx:59`, `:68`|
|4|pass|장식용 카드 묶음을 추가하지 않고 실제 게시판 목록 사용: `school-boards.tsx:64`|
|5|unverified|제목/본문 크기는 기존 서체·토큰을 사용하나 렌더링 계층 확인 불가|
|6|pass|기존 `--ink/--primary/--page/--muted/--line` 사용. 상태는 색 대신 한글 상태명으로 표시: `school-boards.css:1`, `:7`, `:23`; `school-boards.tsx:65`|
|7|unverified|설명 최대 680px·keep-all·overflow-wrap을 적용했으나 실제 한글 줄바꿈 미확인: `school-boards.css:1`, `:4`|
|8|pass|검색/목록/관리 창 각 영역은 필터·게시판 정보·변경 동작을 제공. 기존 수동 ID 입력 폼은 제거: `apps/web/src/features/admin/index.tsx` diff|
|9|pass|지정 색상 계산: 본문 #20372c/흰색 12.77:1, 기본 버튼 흰색/#254b3a 9.78:1, 오류 #8c5b36/#fff2e7 5.21:1, 삭제 버튼 #a24f43/#fff2ef 5.14:1. 경계선 #788279/흰색 3.99:1. 빈 상태/로딩 문구도 본문색으로 보정: `school-boards.css:7`~`:13`. 렌더링 색상 측정은 미수행|
|10|unverified|jsdom Tab/Escape/초점 복원 통과, 실제 브라우저의 가시적 초점 표시는 미확인: `tests/ui/admin-boards.test.tsx`|
|11|unverified|reduced-motion에서 transition/hover 이동 제거 규칙은 있으나 실제 환경 전환 미확인: `school-boards.css:32`|
|12|pass|새 패널의 keep-all과 overflow-wrap: `school-boards.css:1`. 기존 globals.css의 Pretendard/Apple SD Gothic Neo/Noto Sans KR 서체 유지|
|13|unverified|390px 단일 열 규칙은 있으나 실제 가로 넘침 검사 불가: `school-boards.css:31`|
|14|pass|기존 전역 토큰 정의 변경 없음. 관리자 패널 범위 CSS만 추가: git diff|
|15|N/A|학생용 수업/퀴즈 페이지가 아닌 관리자 전용 화면|

Pre-flight: 8/13 passed; fixed: 빈 상태·로딩 본문 대비, 컨트롤 경계선, Node 모드 공통 Dialog 헤더 배치; failed: none; unverified: 실제 화면 계층·줄바꿈·가시적 초점·reduced-motion·390px 넘침; N/A: hero·학습자 페이지.

## 차원 점수와 잔여 사항

6개 차원(Originality, Typography, Color restraint, Layout and hierarchy, Detail, Accessibility)은 모두 before/after `N/V`. 화면 캡처·브라우저 조작 근거 없이 시각 점수를 부여하지 않았다.

|심각도|위치/상태|근거|문제와 영향|반영|재검사|
|---|---|---|---|---|---|
|P2|`/admin` 빈 목록·로딩|공통 EmptyState/Spinner의 연한 글자색|새 영역의 본문 대비 부족|패널 안에서 `--ink`로 변경|지정 색상 계산 12.77:1; 화면 미확인|
|P2|Node 모드 관리 창|Dialog는 게시판 전용 헤더 CSS에 의존|관리자 경로만 불러올 때 헤더 배치 불일치 가능|패널 범위에 헤더 flex 정렬 추가|빌드 통과; 화면 미확인|

코드/테스트에서 확인된 미해결 P0/P1은 없다. 남은 확인 중 우선순위가 높은 항목은 실제 390px 화면에서 긴 제목·교사 이메일 줄바꿈과 관리 창의 키보드 초점이다. 원격 배포와 실제 학교 계정 검수는 수행하지 않았다.
