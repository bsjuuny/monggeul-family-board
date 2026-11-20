# 몽글 패밀리 보드 v2 디자인 명세

작성 기준: `docs/design/mongle-family-board-reference.png`  
대상: 거실 가로형 태블릿·TV 상시 표시 화면  
구현 범위: 이 문서는 디자인 계약이다. 실제 React/TS/CSS 구현과 데이터 모델 변경은 별도 작업에서 한다.

## 1. 디자인 방향

v2는 업무용 대시보드가 아니라, 아침에 멀리서 한 번 보고 가족이 바로 움직일 수 있는 **따뜻한 동화책 한 장**이어야 한다.

- 우선순위는 `지금 시각 → 가장 가까운 등·하원 행동 → 날씨/옷차림 → 꼭 볼 공지 → 준비물`이다.
- 한 화면에 긴 목록을 넣지 않는다. 공지는 핵심 2건, 옷차림 칩은 3개, 준비물은 TV 6개 이하를 기본으로 한다.
- 모든 사용자 문구는 한국어로 쓴다. 장식용 영어, `NEXT`, `AM/PM`을 쓰지 않는다.
- 캐릭터는 생성 이미지에 합성하지 않고 `src/ui/characters/*.tsx`의 200×200 SVG를 React 레이어로 올린다.
- 본문은 그림 위에 직접 놓지 않는다. 항상 단색 카드 또는 명시된 밝은 스크림 위에 놓는다.
- 정보가 없거나 오래돼도 레이아웃은 흔들리지 않는다. 값 자리에 상태 문구를 같은 크기 체계로 표시한다.

## 2. 색 체계

### 2.1 공통 CSS 토큰

```css
:root {
  color-scheme: light;

  /* 바탕과 파스텔 */
  --v2-cream-0: #fffdf8;
  --v2-cream-50: #fffcf5;
  --v2-cream-100: #fff8ea;
  --v2-peach-100: #fce3d8;
  --v2-peach-600: #a9473d;
  --v2-mint-100: #ddefe5;
  --v2-mint-600: #2d766e;
  --v2-sky-100: #dcecf7;
  --v2-sky-600: #2e6580;
  --v2-butter-100: #fff0bf;
  --v2-butter-700: #765c16;
  --v2-lavender-100: #f2e3ee;
  --v2-lavender-700: #7a4d68;

  /* 글자와 구조 */
  --v2-ink: #3d2f2b;
  --v2-ink-muted: #6e5c55;
  --v2-line: #d8cbbe;
  --v2-surface: #fffcf5;
  --v2-surface-strong: #ffffff;
  --v2-surface-glass: rgba(255, 252, 245, 0.94);
  --v2-shadow-color: rgba(88, 62, 46, 0.14);

  /* 의미 색 */
  --v2-accent: #a9473d;
  --v2-accent-soft: #fce3d8;
  --v2-warning: #9a3d31;
  --v2-warning-bg: #fff0e8;
  --v2-success: #2e6f55;
  --v2-success-bg: #eaf6ef;
  --v2-offline: #5e4a43;
  --v2-offline-bg: #fff0bf;
  --v2-focus: #245f9b;

  /* 크기 */
  --v2-radius-card: 30px;
  --v2-radius-inner: 20px;
  --v2-radius-chip: 999px;
  --v2-shadow-card: 0 12px 30px var(--v2-shadow-color),
                    0 2px 6px rgba(88, 62, 46, 0.06);
}
```

용도는 다음과 같이 고정한다.

| 토큰 | 용도 |
|---|---|
| `cream-100` | 전체 바탕, 이미지 로딩 전 대체색 |
| `cream-50`, `surface` | 기본 카드; 본문 카드에는 불투명하게 사용 |
| `surface-glass` | 상단 인사/시계의 장식적 유리 효과만 허용. 뒤에 반드시 밝은 크림 바탕 또는 70% 이상 밝은 스크림이 있어야 함 |
| `peach-100` | 아침 강조, 중요하지만 위험하지 않은 정보 |
| `mint-100` | 오후, 하원, 완료/안심 맥락 |
| `sky-100` | 날씨와 미니 예보 |
| `butter-100` | 준비물, 오프라인 띠 |
| `lavender-100` | 저녁, 내일 정보 |
| `ink` | 제목·본문·큰 숫자 |
| `ink-muted` | 날짜, 단위, 보조 설명. 14px 미만 금지 |
| `line` | 카드 구분선. 텍스트 색으로 사용하지 않음 |
| `warning` | `확인 필요`, `답장 필요`, 시간 변경 |
| `success` | 확인 완료, 준비 완료 |

### 2.2 검증한 명도 대비

아래 값은 sRGB 상대 휘도 기반 WCAG 대비값이다. 본문은 4.5:1, 24px 이상 또는 18.66px 굵은 글자는 3:1 이상을 기준으로 한다.

| 전경 / 배경 | 대비 | 허용 범위 |
|---|---:|---|
| `#3D2F2B` / `#FFF8EA` | 12.11:1 | 모든 글자 |
| `#3D2F2B` / `#FFFCF5` | 12.50:1 | 모든 글자 |
| `#6E5C55` / `#FFF8EA` | 5.97:1 | 본문·보조 글자 |
| `#6E5C55` / `#FFFCF5` | 6.16:1 | 본문·보조 글자 |
| `#A9473D` / `#FFF8EA` | 5.43:1 | 아침 강조 글자 |
| `#2D766E` / `#FFF8EA` | 5.06:1 | 오후 강조 글자 |
| `#66508A` / `#FFF8EA` | 6.45:1 | 저녁 강조 글자 |
| `#9A3D31` / `#FFF0E8` | 6.12:1 | 경고 배지 |
| `#2E6F55` / `#EAF6EF` | 5.38:1 | 성공 배지 |
| `#765C16` / `#FFF0BF` | 5.57:1 | 준비물·오프라인 |
| 흰색 / `#A9473D` | 5.74:1 | 선택된 아침 버튼 |
| 흰색 / `#2D766E` | 5.35:1 | 선택된 오후 버튼 |
| 흰색 / `#66508A` | 6.82:1 | 선택된 저녁 버튼 |

`line`만으로 상태를 알리지 않는다. 배지에는 아이콘과 텍스트를 함께 표시한다. 이미지 위 반투명 카드에서 대비가 달라질 수 있으므로 본문 카드는 불투명 `surface`를 기본으로 하고, `surface-glass`는 짧은 큰 글자에만 쓴다.

### 2.3 시간대 토큰

시간대는 사용자 설정 시각을 우선하고, 기본값은 아침 05:00–11:29, 오후 11:30–17:29, 저녁 17:30–04:59이다. 수동 선택은 다음 자동 전환 전까지 유지한다.

```css
[data-period="morning"] {
  --v2-sky-gradient: linear-gradient(180deg, #dcecf7 0%, #fce3d8 58%, #fff4ce 100%);
  --v2-accent: #a9473d;
  --v2-accent-soft: #fce3d8;
  --v2-scene: url('/art/board/scene-morning.png');
}

[data-period="afternoon"] {
  --v2-sky-gradient: linear-gradient(180deg, #cfe9f4 0%, #ddefe5 64%, #fff8ea 100%);
  --v2-accent: #2d766e;
  --v2-accent-soft: #ddefe5;
  --v2-scene: url('/art/board/scene-afternoon.png');
}

[data-period="evening"] {
  --v2-sky-gradient: linear-gradient(180deg, #d9d5ee 0%, #f3d6d0 62%, #fff0bf 100%);
  --v2-accent: #66508a;
  --v2-accent-soft: #f2e3ee;
  --v2-scene: url('/art/board/scene-evening.png');
}
```

## 3. 글꼴과 숫자

외부 CDN과 원격 `@import`를 쓰지 않는다. 개발자가 npm 패키지를 설치해 빌드 산출물에 WOFF2를 포함한다.

- 숫자·제목: **Jua**, `@fontsource/jua`, 400. 둥근 획과 손글씨 인상이 레퍼런스에 가장 가깝고, 큰 숫자와 짧은 제목의 실루엣이 멀리서도 잘 구분된다. Jua는 한 굵기만 사용한다.
- 본문·상태: **Noto Sans KR**, `@fontsource/noto-sans-kr`, 400/500/700. 장문과 작은 보조 글자에서 자소가 안정적이고 TV 렌더링 가독성이 좋다.
- 대체 순서: `"Jua", "Noto Sans KR", system-ui, sans-serif` 또는 본문에서 `"Noto Sans KR", system-ui, sans-serif`.
- 숫자는 `font-variant-numeric: tabular-nums lining-nums;`를 적용한다. 시계 폭이 초마다 흔들리면 안 된다.
- 본문 자간 `-0.015em`, 제목 `-0.025em`, 큰 숫자 `-0.035em`. 16px 이하에서 음수 자간을 더 줄이지 않는다.
- 구현 시 필요한 정적 폰트만 import한다. 예: Jua 400, Noto Sans KR 400/500/700. `font-display: swap`을 유지한다.

### 3.1 타입 스케일

```css
--v2-type-clock: clamp(64px, 7.1vw, 136px);
--v2-type-count: clamp(50px, 5.2vw, 100px);
--v2-type-temp: clamp(58px, 5.8vw, 112px);
--v2-type-greeting: clamp(26px, 2.3vw, 44px);
--v2-type-card-title: clamp(22px, 1.6vw, 30px);
--v2-type-body: clamp(17px, 1.1vw, 22px);
--v2-type-support: clamp(15px, 0.9vw, 18px);
--v2-type-chip: clamp(15px, 0.92vw, 18px);
```

- 시계: Jua 400, line-height `0.9`.
- 카운트다운·기온: Jua 400, line-height `0.95`; 단위는 Noto Sans KR 700, 숫자의 42% 크기.
- 카드 제목: Jua 400, line-height `1.15`.
- 본문: Noto Sans KR 500, line-height `1.45`.
- 칩: Noto Sans KR 700, line-height `1.2`.
- 모바일에서는 별도 상한을 둔다: 시계 `clamp(52px, 17vw, 68px)`, 카운트다운 `clamp(44px, 14vw, 58px)`, 기온 `clamp(52px, 16vw, 64px)`.

## 4. 전체 레이아웃

### 4.1 공통 구조

DOM과 키보드 탐색 순서는 다음을 고정한다.

1. 오프라인/오래된 데이터 띠(있을 때)
2. 인사·날짜·시계
3. 아침/오후/저녁 전환
4. 창밖 풍경
5. 등하원 카드
6. 날씨 카드
7. 공지톡 소식
8. 준비물

큰 가로 화면에서는 CSS Grid로 날씨를 왼쪽, 등하원을 중앙, 공지/준비물을 오른쪽에 보이게 재배치해도 DOM 순서는 바꾸지 않는다.

```css
.v2-board {
  position: relative;
  min-height: 100dvh;
  color: var(--v2-ink);
  background-color: var(--v2-cream-100);
  background-image: var(--v2-sky-gradient);
  background-repeat: no-repeat;
}

.v2-board::before {
  content: '';
  position: fixed;
  z-index: 0;
  inset: 0;
  pointer-events: none;
  background: url('/art/board/paper-texture.png') repeat;
  mix-blend-mode: multiply;
  opacity: 0.04;
}

.v2-board__inner {
  position: relative;
  z-index: 1;
}

.v2-card {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(216, 203, 190, 0.82);
  border-radius: var(--v2-radius-card);
  background: var(--v2-surface);
  box-shadow: var(--v2-shadow-card);
}
```

종이 질감은 별도 pseudo-element에 `mix-blend-mode: multiply; opacity: .04`로 올린다. 카드 위 질감은 `.03`을 넘지 않는다.

### 4.2 뷰포트별 고정 규칙

| 뷰포트 | 바깥 여백 / 간격 | 상단 영역 | 정보 카드 배치 | 반경 / 그림자 | 스크롤 |
|---|---|---|---|---|---|
| 1920×1080 TV | 32px / 20px | 높이 282px. 인사·시계 38%, 풍경 62% | `1.00fr 1.08fr .96fr`; 날씨/등하원/소식+준비물 3열 | 카드 32px, 내부 20px, 기본 그림자 | 없음 |
| 1280×800 | 24px / 16px | 높이 212px. 40%/60% | `31% 36% 33%` 3열. 오른쪽은 공지 58%, 준비물 42% | 카드 26px, 그림자 y 10 blur 24 | 없음 |
| 1024×768 가로 태블릿 | 20px / 14px | 높이 184px. 42%/58% | 2열×2행. 1행 날씨/등하원, 2행 소식이 2열 span; 준비물은 소식 오른쪽 40% 영역 | 카드 24px, 그림자 y 8 blur 20 | 없음 |
| 768×1024 세로 태블릿 | 20px / 14px | 높이 210px. 인사 42%, 풍경 58% | 2열×2행. 날씨/등하원 각 1열, 소식+준비물 2열 span. 하단 전환 버튼 포함 총 높이 안에 맞춤 | 카드 24px | 없음 |
| 390×844 | 16px / 12px | 인사 150px, 풍경 `aspect-ratio: 2.4/1` | 단일 열. 등하원→날씨→소식→준비물 | 카드 22px, 그림자 y 6 blur 18 | 세로 허용 |
| 360×800 | 14px / 10px | 인사 142px, 풍경 `aspect-ratio: 2.4/1` | 단일 열. 390과 동일; 카드 패딩 16px | 카드 20px | 세로 허용 |

TV/태블릿의 세로 계산은 상태 띠가 없을 때 기준이다. 상태 띠가 나타나면 전체 보드의 최상단 44px를 차지하고, 1920/1280에서는 상단 영역을 12px, 카드 영역을 32px 줄인다. 1024/768에서는 카드 내부 패딩과 카드 제목 하단 여백을 각각 4px 줄여 스크롤을 만들지 않는다.

### 4.3 권장 그리드 값

```css
/* 1280 이상 */
.v2-board__inner {
  height: 100dvh;
  padding: 24px;
  display: grid;
  grid-template-rows: 212px minmax(0, 1fr);
  gap: 16px;
}
.v2-hero { display: grid; grid-template-columns: minmax(380px, 2fr) minmax(0, 3fr); gap: 16px; }
.v2-cards { display: grid; grid-template-columns: 31fr 36fr 33fr; gap: 16px; }

/* 1024×768 */
@media (max-width: 1100px) and (orientation: landscape) {
  .v2-board__inner { padding: 20px; gap: 14px; grid-template-rows: 184px minmax(0, 1fr); }
  .v2-cards { grid-template: minmax(0, 1.15fr) minmax(0, .85fr) / repeat(2, minmax(0, 1fr)); }
  .v2-notice-ready { grid-column: 1 / -1; }
}

/* 모바일 */
@media (max-width: 600px) {
  .v2-board { min-height: 100dvh; }
  .v2-board__inner { height: auto; min-height: 100dvh; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .v2-cards { display: contents; }
  .v2-commute { order: 1; }
  .v2-weather { order: 2; }
  .v2-notice-ready { order: 3; }
}
```

가로 TV는 화면 가장자리 overscan을 고려해 핵심 텍스트를 바깥 40px 안쪽에 둔다. 카드 내부 패딩은 TV 26px, 1280 22px, 1024/768 18px, 모바일 16px이다.

## 5. 컴포넌트 명세

### 5.1 상단 인사·시계

- 왼쪽 정렬. 인사는 최대 2줄, 예: `좋은 아침이에요, 서윤이`.
- 날짜는 `11월 20일 금요일`처럼 쓰고 연도는 생략한다.
- 시각은 24시간제 `08:05`. 초는 표시하지 않는다.
- 시계와 날짜 사이 10px, 인사와 시계 사이 TV 16px/모바일 10px.
- 시계 박스는 `surface-glass`, 1px 선, 30px 반경. 그림자 대신 바깥쪽 크림 하이라이트 `0 0 0 4px rgba(255,255,255,.28)`를 허용한다.
- 긴 이름은 말줄임하지 말고 인사 부분만 두 줄로 감싼다. 시계는 항상 한 줄이다.

시간대별 기본 인사:

- 아침: `좋은 아침이에요, {이름}`
- 오후: `즐거운 오후예요, {이름}`
- 저녁: `오늘도 수고했어요, {이름}`

### 5.2 창밖 풍경과 SVG 캐릭터

- 풍경 컨테이너는 `position: relative; overflow: hidden; border-radius: 30px;`.
- 배경은 `background-image: var(--v2-scene); background-size: cover; background-position: center 52%;`.
- 2.4:1보다 좁은 컨테이너에서는 좌우 창틀보다 중앙 언덕·창턱을 보존한다. `object-position`을 시간대마다 바꾸지 않는다.
- 하단 24%는 캐릭터 좌석 영역이다. 이 영역에 본문이나 버튼을 놓지 않는다.
- 캐릭터 SVG는 `position: absolute; z-index: 2; filter: drop-shadow(0 6px 8px rgba(88,62,46,.16));`.
- SVG 내부 색과 선은 수정하지 않는다. `mood` prop만 `happy | cheer | sleepy` 중 사용한다.

권장 캐릭터 조합과 위치:

| 시간대 | 캐릭터 | 위치·크기(풍경 기준) |
|---|---|---|
| 아침 | 몽글이 `happy` + 보들이 `happy` | 몽글이 오른쪽 30%, bottom 3%, width 18%; 보들이 오른쪽 19%, bottom 4%, width 12% |
| 오후 | 포근이 `happy` + 쪼꼬미 `cheer` | 포근이 오른쪽 27%, bottom 2%, width 17%; 쪼꼬미 오른쪽 16%, bottom 3%, width 11% |
| 저녁 | 몽글이 `sleepy` + 나비 `sleepy` | 몽글이 오른쪽 29%, bottom 2%, width 18%; 나비 오른쪽 17%, bottom 3%, width 12% |

모바일 풍경에서는 각 크기를 1.15배로 올리되 두 캐릭터 합계가 풍경 너비의 40%를 넘지 않게 한다. 데이터 상태를 캐릭터 표정 하나에만 의존해 전달하지 않는다.

### 5.3 날씨 카드

구조는 다음 순서를 고정한다.

1. 제목 `오늘 날씨` 또는 저녁의 `내일 날씨` + 갱신 시각/오래된 날씨 배지
2. 현재 또는 기준 시점 날씨: 선 아이콘, 큰 기온, 짧은 상태 문구
3. 옷차림·우산 칩 최대 3개
4. 등원/하원 시점 미니 예보 2개

- 카드 배경 `surface`; 상단 날씨 영역만 `sky-100` 28% 투명 그라데이션을 쓸 수 있다.
- 기온 숫자와 단위 baseline을 맞춘다. `3°C`가 아니라 `3°`를 큰 값으로 쓰고 상태 문구에 `체감 0도`를 보조로 둔다.
- 상태 문구는 12자 이내: `맑고 쌀쌀해요`, `비가 올 수 있어요`.
- 칩: 높이 TV 52px, 태블릿 44px, 모바일 42px; 좌우 패딩 14px; 칩 사이 8px. 한 줄 초과 시 마지막 칩을 숨기지 말고 줄바꿈한다.
- 칩 문구 예: `두꺼운 겉옷`, `목도리`, `우산 챙겨요`. 이모지를 쓰지 않고 20–24px 선 아이콘을 쓴다.
- 미니 예보는 같은 너비 2열. `등원 08:30 · 3°`, `하원 16:30 · 9°`; 시각이 없으면 `등원 시점 미설정`.
- 날씨가 오래됐으면 큰 값은 마지막 수신 값을 유지하되 카드 전체를 회색 처리하지 않는다. 제목 옆에 `오래된 날씨` 배지와 `오전 6:10 기준`을 표시한다.

### 5.4 등하원 카드

- 카드 안에 `commute-path.png`를 장식 레이어로 사용한다: `background-size: 72% auto; background-position: right bottom; opacity: .24;`.
- 텍스트와 배경 그림 사이에 `linear-gradient(90deg, var(--v2-surface) 0 45%, rgba(255,252,245,.82) 72%, rgba(255,252,245,.55))` 스크림을 둔다.
- 큰 카운트다운은 한 시점만 최상위로 보인다. 두 숫자를 같은 크기로 경쟁시키지 않는다.

시간대별 내용:

| 시간대 | 큰 값 | 보조 정보 | 지난 뒤 문구 |
|---|---|---|---|
| 아침 | `등원 출발까지 25분` | `08:30 출발`, 하원 `16:30 · 7시간 10분` | `등원 준비 끝` 또는 `출발 시각이 지났어요` |
| 오후 | `하원까지 1시간 20분` | `16:30 하원`, `픽업 · 아빠` | `하원 완료` 또는 `하원 확인 필요` |
| 저녁 | `내일 등원 08:30` | 내일 출발까지 남은 시간은 12시간 이상이면 작은 문구로만 표시 | `내일 등원 시간이 필요해요` |

- 큰 값은 2줄까지 허용한다. 숫자는 `--v2-type-count`, 라벨은 카드 제목 크기.
- 예정 시각 pill은 높이 42–48px, `accent-soft` 배경, `accent` 글자.
- 픽업 담당자는 얼굴 사진 대신 이름과 24px 보호자 선 아이콘을 쓴다. 미정이면 `픽업 담당자 확인 필요` 경고 배지.
- 카운트다운은 1분 단위로 갱신한다. 60분 미만은 `25분`, 60분 이상은 `1시간 20분`, 12시간 이상은 `내일 08:30`처럼 행동 가능한 표현으로 바꾼다.
- 완료/지난 상태에서는 숫자 영역을 성공 배지와 상태 문구로 교체하고 카드 높이는 유지한다.

### 5.5 공지톡 소식 카드

- 제목 `공지톡 소식`; 오른쪽에 전체 미확인 수를 `확인할 소식 2건`으로 표시한다.
- 핵심 공지는 최대 2건만 노출한다. 각 공지 제목은 최대 3줄, 보조 설명은 1줄이다.
- 항목 높이 TV 최소 104px, 태블릿 84px, 모바일 92px. 항목 간 10px.
- 중요도 순서: `확인 필요` → `답장 필요` → 새 공지 → 일반 공지. 시간 역순보다 상태를 우선한다.
- `확인 필요`: warning 아이콘 + `확인 필요`, `warning-bg`/`warning`.
- `답장 필요`: 말풍선 선 아이콘 + `답장 필요`, `peach-100`/`peach-600`.
- 두 배지가 동시에 필요하면 한 줄에 나란히 놓고, 모바일에서는 두 번째를 다음 줄로 보낸다.
- 항목 전체가 버튼/링크라면 항목 하나에 포커스가 가게 하고 내부 배지는 포커스 대상에서 제외한다.
- 공지가 2건보다 많으면 하단에 `그 밖의 소식 3건` 한 줄만 표시한다. 자동 롤링·마키는 금지한다.

### 5.6 준비물 칩

- 제목은 시간대에 따라 `오늘 준비물` 또는 `내일 준비물`.
- 칩에는 20px 선 아이콘, 품목명, 선택적으로 수량을 표시한다: `물통`, `여벌옷`, `도화지 2장`.
- 최대 노출: 1920/1280 6개, 1024/768 4개, 모바일 4개. 나머지는 `외 2개` 칩으로 합친다.
- 기본 칩 `butter-100`/`butter-700`, 확인 완료 칩 `success-bg`/`success`.
- 칩을 조작 가능하게 구현할 경우 최소 높이 48px와 명시적 `aria-pressed`를 쓴다. TV 디스플레이 전용 읽기 상태라면 포커스 대상이 아니다.

### 5.7 아침/오후/저녁 수동 전환

- 한국어 세 버튼 `아침`, `오후`, `저녁`; 장식 영어 금지.
- `role="tablist"`/`role="tab"` 또는 동일한 키보드 동작의 segmented control로 구현한다.
- 높이 TV 56px, 태블릿/모바일 48px. 각 버튼 최소 너비 72px, 모바일은 같은 너비 1fr.
- 선택 버튼은 `accent` 배경 + 흰색 글자, 미선택은 `surface` + `ink` + 1px 선.
- 좌우 화살표로 이전/다음, Home/End로 처음/끝, Enter/Space로 선택한다. Tab 키는 선택된 버튼 하나에만 진입하는 roving tabindex가 바람직하다.
- 리모컨 포커스는 선택 상태와 별개다. 선택은 채움, 포커스는 바깥 링으로 구분한다.

### 5.8 오프라인·오래된 데이터 띠

- 화면 최상단 전체 너비. 높이 TV/태블릿 44px, 모바일 내용에 따라 최소 48px.
- 오프라인: `offline-bg`/`offline`, 끊어진 연결 아이콘 + `오프라인 · 마지막으로 받은 정보를 보여드려요`.
- 오래된 날씨: `warning-bg`/`warning`, 새로고침 아이콘 + `날씨를 새로 받지 못했어요 · 오전 6:10 기준`.
- 둘 다 발생하면 띠 하나에 `오프라인 · 날씨는 오전 6:10 기준이에요`로 합친다. 띠 두 개를 쌓지 않는다.
- 닫기 버튼을 두지 않는다. 상태가 회복되면 `연결됐어요 · 정보 갱신 완료` 성공 띠를 3초 보여 준 뒤 제거한다.
- 색, 아이콘, 문구 세 가지를 함께 써서 상태를 전달한다.

### 5.9 빈 상태 문구

공간을 채우려고 장문을 쓰지 않는다. 아래 문구를 기본값으로 사용한다.

| 상태 | 제목 | 보조 문구 |
|---|---|---|
| 일정 없음 | `오늘은 정해진 일정이 없어요` | `가족과 천천히 보내요` |
| 날씨 미설정 | `날씨 지역을 정해 주세요` | `보호자 화면에서 지역을 설정할 수 있어요` |
| 공지 없음 | `새로운 공지가 없어요` | `확인할 소식이 생기면 여기에 보여드려요` |
| 준비물 없음 | `챙길 준비물이 없어요` | `가볍게 출발해요` |
| 등하원 시각 없음 | `등하원 시간이 필요해요` | `보호자 화면에서 시간을 알려 주세요` |
| 픽업 담당자 없음 | `픽업 담당자 확인 필요` | `누가 데리러 갈지 정해 주세요` |

빈 상태 캐릭터는 카드당 하나만, 폭 88–120px. `sleepy`는 정말 할 일이 없는 상태, `happy`는 설정 안내에 사용한다. 오류를 웃는 표정만으로 표현하지 않는다.

## 6. 아이콘 규칙

이모지와 운영체제별 컬러 아이콘을 쓰지 않는다. 필요한 아이콘은 다음 SVG path 규칙으로 제작한다.

- `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`.
- 기본 선 두께 2.25px, 큰 32px 아이콘은 2px, 16px 아이콘은 2.5px.
- `stroke-linecap="round"`, `stroke-linejoin="round"`.
- 모서리 반경은 2–3px 느낌, 뾰족한 각을 피한다.
- 기본 24px, 칩 20px, 날씨 대표 72–96px.
- 햇빛·비·구름은 3개 이하의 단순 도형으로 만든다. 얼굴을 넣지 않는다.
- 아이콘만 있는 조작 버튼은 금지에 가깝게 보고, 꼭 필요한 경우 한국어 `aria-label`과 48px 터치 영역을 제공한다.

## 7. 움직임

움직임은 정보를 방해하지 않는 장식으로 제한한다.

| 대상 | 값 |
|---|---|
| 캐릭터 둥실 | `4200ms cubic-bezier(.45,0,.55,1) infinite alternate`; `translateY(0)` ↔ `translateY(-6px)`; 두 캐릭터 delay 700ms 차이 |
| 눈 깜빡임 | 6–9초 사이 고정된 캐릭터별 주기, 닫힘 90ms + 유지 60ms + 열림 90ms. 동시에 깜빡이지 않음 |
| 시계 콜론 | `1200ms ease-in-out infinite`; opacity 1 ↔ .38. 레이아웃 폭 변화 없음 |
| 카운트다운 숫자 변경 | 이전 값 opacity 1→0, `translateY(0→-4px)` 140ms; 새 값 0→1, `translateY(4px→0)` 220ms `cubic-bezier(.2,.8,.2,1)` |
| 상태 띠 등장 | 180ms ease-out, y -8px→0, opacity 0→1 |

흔들기, 큰 확대, confetti, 자동 슬라이드, 배경 parallax는 쓰지 않는다. `prefers-reduced-motion: reduce`에서는 모든 무한 애니메이션을 중지하고, 상태 변경은 즉시 교체한다. 콜론은 항상 보이는 정적 상태로 둔다.

```css
@media (prefers-reduced-motion: reduce) {
  .v2-board *, .v2-board *::before, .v2-board *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 8. 포커스·리모컨·터치

- 모든 조작 대상 최소 크기: 터치 48×48px, TV 리모컨 56×48px. 조작 대상 사이 시각 간격 최소 8px.
- 기본 포커스: `outline: 4px solid #245F9B; outline-offset: 4px; box-shadow: 0 0 0 2px #FFFDF8;`.
- warning 배경에서도 포커스가 보이도록 파란 링을 유지한다. `outline: none`만 단독으로 쓰지 않는다.
- 포커스 시 카드 전체를 1.02배 키우지 않는다. TV에서 인접 요소가 흔들리므로 `translateY(-2px)`와 그림자 강화까지만 허용한다.
- 시각적 순서와 방향키 이동 순서를 맞춘다. 3열 TV에서는 좌/중/우 카드, 카드 안에서는 위/아래 순서다.
- 포커스가 화면 밖으로 이동하지 않도록 모바일에서 `scroll-margin: 20px`, TV에서 가장자리 40px safe area를 둔다.
- 현재 시간대, 확인 완료, 비활성 상태를 포커스만으로 표현하지 않는다.

## 9. 시간대별 정보 우선순위

### 아침

1. 등원 출발까지 남은 시간
2. 현재/등원 시점 날씨와 옷차림·우산
3. 오늘 준비물
4. 시간 변경·답장 필요 공지
5. 하원 시각

### 오후

1. 하원까지 남은 시간과 하원 날씨
2. 픽업 담당자
3. 전달 사항·확인 필요 공지
4. 현재 날씨
5. 남은 오늘 준비물

### 저녁

1. 내일 날씨와 내일 등원 시각
2. 내일 준비물
3. 내일 행사
4. 부모 확인 사항
5. 오늘 완료 상태

데이터가 없다고 낮은 우선순위 항목을 큰 영역으로 승격하지 않는다. 빈 상태를 원래 자리에서 짧게 보여 준다.

## 10. 레퍼런스와 의도적으로 달라지는 점

- 레퍼런스의 정적인 아침 한 장을 아침/오후/저녁 3개 상태로 확장한다. 같은 구도를 유지해 시간 전환이 제품 상태 변화처럼 느껴지게 한다.
- 레퍼런스의 큰 브랜드 제목은 제거한다. 상시 디스플레이에서 필요한 것은 제품명보다 시각과 행동 정보다.
- 레퍼런스의 장식 아이콘 일부는 단색 선 아이콘으로 단순화한다. 이모지/그림 아이콘의 플랫폼 차이를 없애고 상태 색 대비를 통제하기 위함이다.
- 흰 카드의 투명도를 낮추지 않고 본문 카드는 거의 불투명하게 한다. 수채화 분위기보다 장거리 가독성과 WCAG 대비를 우선한다.
- 공지 카드에 `확인 필요`, `답장 필요`, 오프라인/오래된 날씨 상태를 명시한다. 레퍼런스의 예쁜 정상 상태만으로는 실제 가정의 실패·확인 흐름을 다룰 수 없다.
- 캐릭터를 배경 그림에 그리지 않고 기존 SVG를 겹친다. 표정·크기·접근성 이름을 상태별로 바꾸고, 원본 캐릭터 자산을 한 곳에서 유지하기 위함이다.
- 1024 이하에서는 3열을 고집하지 않는다. 정보 밀도를 낮게 유지하면서 한 화면에 담기 위해 2열×2행으로 바꾼다.

## 11. 구현 완료 판정 체크리스트

- 1920×1080, 1280×800, 1024×768, 768×1024에서 브라우저 스크롤바가 없다.
- 390×844, 360×800에서 명시된 순서로 세로 스크롤되며 가로 스크롤이 없다.
- 모든 본문/상태 텍스트 조합이 위 대비표의 전경·배경 쌍을 사용한다.
- 장식 영어와 컬러 이모지가 없다.
- 공지 2건, 각 3줄; 옷차림 칩 3개; 준비물 개수 제한이 지켜진다.
- 오프라인, 오래된 날씨, 확인 필요, 답장 필요, 빈 상태를 실제 데이터 상태로 각각 확인한다.
- 리모컨 방향키/Tab/Enter/Space로 시간대 전환과 공지 진입이 가능하고 포커스가 항상 보인다.
- `prefers-reduced-motion`에서 둥실·깜빡임·콜론·숫자 전환이 정지한다.
- 풍경 생성 이미지에는 글자·숫자·UI·캐릭터가 없고, 캐릭터는 기존 SVG만 사용한다.

