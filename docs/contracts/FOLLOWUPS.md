# 후속 작업 공통 계약

2026-10-12. 통합 담당이 contracts, schema, migration, dispatch, 기존 boards 서버, Workspace 연결, Worker, 설정·의존성·문서를 소유한다. 작업자는 지정된 신규 모듈/파일만 변경하고 필요한 계약 변경은 통합 담당에게 전달한다.

- 초안: `GET /api/boards/:boardId/drafts` -> `PostDraft[]`. 편집 초안은 edit_post_version으로 원글 버전을 보존하고 자동 덮어쓰지 않음. `PUT /api/boards/:boardId/drafts/:id` -> `PostDraft` (클라이언트 UUID, 최초 version=0, 이후 CAS version). `DELETE` 같은 경로 body `{version}`. 본인 소유권·최신 게시판/공유 쓰기 범위·편집 대상·첨부 소유권 검사. 타인 초안 조회 금지. 최대 사용자 20개·본문 10000·제목 200·14일 보관. 게시 API에는 선택적인 `{draft_id,draft_version}`를 더하고 성공 트랜잭션에서 동일 소유/버전 초안만 삭제한다. 다른 탭 변경은 409, 실패 내용은 덮어쓰지 않음.
- 초안 Compose 모듈: `DraftCompose` props `{view,post?,sectionId?,draftId?,onClose,onSaved,onMinimize}`. 닫기/최소화 전에 저장, 오류 시 창 유지. 업로드는 기존 무료 압축·개수·크기·권한 API 유지. 목록/최소화 버튼은 통합 담당이 Workspace에 연결한다. 모듈은 class/기존 Dialog 재사용 가능. localStorage에 학생 원문 저장하지 않음.
- 교사 허용 명단: `GET /api/admin/admissions` -> `TeacherAdmission[]`, `PUT /api/admin/admissions` body `{email,enabled}`. 관리자가 학교 도메인 이메일만 명시 등록. DB enabled=false는 환경 allowlist보다 우선; 환경 관리자 권한은 별도. 기존 계정 권한 철회는 세션 삭제와 역할 반영, 관리자 자신 제거 금지. 학교 도메인/verified/hd 서버 검증 유지. 익명 계정 연결은 post_drafts 소유권도 이전한다.
- 섹션: POST 기존 create는 `{title,before_id?,after_id?,version?}`. 새 DELETE `/api/boards/:boardId/sections/:sectionId` body `{version,move_to:string|null}`는 이동 대상 검증 후 글을 이동하고 섹션 soft delete·해당 공유 회수. restore POST 같은 경로 `/restore` body `{version}`. Manager만 deleted_sections DTO. 복원은 옮겨진 글 위치와 회수된 공유를 자동 되돌리지 않음.
- 정렬: POST `/api/boards/:boardId/sections/reorder` body `{version,section_ids}`와 `/posts/reorder` body `{version,section_id,post_ids}`는 교사만, 현재 대상 전체 집합·중복·board version 검증 후 rank 반영. 드래그는 기존 이동 버튼의 대안이며 학생 글 소유권을 바꾸지 않음.
- 외형: 기존 Board PATCH에 `{column_width:260..440,font_scale:small|normal|large,card_density:comfortable|compact,background_style:solid|gradient|paper}`. 기존 color는 배경, Post color는 카드. 게시판 설정 저장/version/형식 변경 내용 유지 계약 동일.
- 발표: 기존 권한 필터된 BoardView의 공개 글만 사용하고 학생의 제출 전용/글 초대 범위 유지. 별도 무권한 데이터 조회·공개 파일 URL 금지. 현재 섹션 선택·키보드·전체 화면, 권한 회수 시 열린 발표 내용 제거.
- 운영: `handleOperations(req,path)` 신규 서버 모듈, 모든 경로 `/api/admin/operations/*` 관리자 전용. `runMaintenance()` scheduled entrypoint. OperationRun 공통 타입/operation_runs 테이블. 백업은 비공개 Supabase 저장, 크기/보관 한도 명시, 새 리소스는 무료 한도 내. BACKUP_ENCRYPTION_KEY 설정은 통합 담당이 지원. 운영 데이터 복원은 실행하지 않으며 테스트 DB에서 실제 복원하고 운영용 dry-run/명시 확인 흐름 구현. 세션·OAuth 비밀과 과거 공유 권한을 복원해 재활성화하지 않음. 프론트는 `OperationsPanel` 신규 features/operations에 작성하고 통합 담당에게 admin 연결 요청.

각 담당은 자체 테스트 파일을 만든다. 공유 파일 편집, git commit/브랜치 전환, 실제 계정 추가/운영 복원/원격 삭제/유료 설정은 수행하지 않는다.
