# Video Doorbell Lock (비디오 초인종 도어락)

Homey 앱으로 비디오 초인종과 스마트 도어락을 함께 제어합니다.

## 구성

- **초인종(doorbell) 드라이버**: 초인종 눌림 감지, 카메라 스냅샷/영상, 눌림 시 Flow 트리거
- **도어락(lock) 드라이버**: 잠금/해제(`locked`), 배터리 등

> 이 저장소는 스캐폴드 상태입니다. 실제 기기 연동(로컬/클라우드 API, 페어링 로직, 카메라 이미지 소스)은 각 드라이버의 `driver.js` / `device.js`에 구현하세요.

## 개발 메모 (Homey 앱스토어 가이드라인 요약)

- **앱 이름**: 최대 4단어, 브랜드/프로토콜/회사명·"Homey" 사용 금지
- **Description**: 앱 이름·readme와 겹치지 않는 짧은 태그라인
- **README(.txt/.ko.txt)**: 제목·기능/Flow 목록·설치 안내·URL·마크다운 없이 1~2문단 plain text (스토어 노출). "Homey" 언급 지양
- **앱 이미지**: 250×175 / 500×350 / 1000×700, 단색 배경 플랫 아이콘 금지 → 생동감 있는 이미지
- **드라이버 이미지**: 75×75 / 500×500 / 1000×1000, 흰 배경 + 기기 이미지, 앱 이미지 재사용 금지
- **아이콘**: 투명 배경 벡터 SVG(960×960 캔버스), 앱 아이콘과 드라이버 아이콘은 서로 달라야 함
- **Flow 카드 제목**: 짧고 명확, 괄호·When/And/Then·기기명 금지 (인자는 `titleFormatted`)
- **번역**: 영어 필수, 모든 title/label/hint는 en+ko 등 일관되게(부분 번역 금지)
- **capability 순서 변경/추가**: 기존 기기엔 `onInit`의 `addCapability`(ensureCapabilities 패턴)로 마이그레이션 필요
- `.DS_Store`는 `.homeyignore`/`.gitignore`로 제외

## 라이선스

GPL-3.0-or-later

## 개발자

- Geunwon Mo (mokorean@gmail.com)
