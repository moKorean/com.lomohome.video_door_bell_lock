# Video Doorbell and Lock (비디오 도어벨 & 락 · RTSP & Matter)

RTSP IP 카메라(비디오 초인종 포함), 스마트 도어락, 모션·초인종 센서를 **하나의 기기 화면**으로 묶는 Homey 앱입니다. 영상·센서 상태·도어락 제어를 한 타일에서 함께 다룹니다.

**RTSP를 지원하는 비디오 도어벨·카메라와 도어락을 함께 사용할 수 있습니다.**

## 주요 기능

- **RTSP 라이브 영상 (다중 카메라)**: `createVideoRTSP()` + `registerVideoUrlListener()` 로 네이티브 스트리밍(클라우드/트랜스코딩 없음). 한 기기에 카메라 1~4대.
- **네트워크 카메라 검색**: ONVIF WS-Discovery + TCP 포트 스캔(554·8554) 폴백. 후보 선택 시 편집형 RTSP 템플릿(`rtsp://<user>:<pass>@ip:port/<path>`)을 채워주고, 예시로 수정 방법을 안내.
- **도어락 제어(선택)**: 연동한 도어락의 `locked`를 미러링하고 타일 **빠른동작 토글**(`uiQuickAction`)로 잠금/해제.
- **센서 연동(선택)**: 초인종 센서 → `alarm_generic`, 모션 센서 → `alarm_motion`. 연동 즉시 현재 상태를 반영하고, 변화 시 Flow 트리거.
- **동적 UI**: 연동한 기기에 따라 capability를 런타임에 추가/제거(`applyConfig`). 카메라만 있으면 영상만, 도어락·센서까지 연동하면 모두 표시.
- **연동 기기 변경**: 페어링 후에도 **유지보수 → 수리 시도(Repair)** 로 카메라/도어락/센서를 다시 선택해 즉시 재적용.
- **다국어(en/ko)**: 페어링·복구 화면이 Homey 언어(`i18n.getLanguage()`)를 따라 한국어/영어로 표시. 고급 설정 라벨·힌트도 en/ko.

## Flow 카드

- 트리거: `doorbell_rang`(초인종 눌림), `motion_detected`(모션 감지)
- 조건: `lock_is_locked`(잠겨 있으면)

## 페어링 / 복구

- **페어링**(`drivers/smartdoor/pair/configure.html`): 카메라(이름+RTSP URL, 검색 지원)와 선택적 도어락/초인종/모션 센서를 고른 뒤 기기 생성.
- **복구**(`drivers/smartdoor/repair/reconfigure.html`): 동일 화면에 현재 설정이 채워진 상태로 열려 변경 후 저장. repair 뷰 HTML은 반드시 `drivers/<id>/repair/` 폴더에 두어야 함(`pair/`에 두면 `unknown_error_getting_file`).
- 두 뷰는 동일 파일이며, `getConfig` 결과(null=페어링 / 설정=복구)로 동작을 분기.

## 구조

- `app.js` — `homey-api` 초기화(`HomeyAPI.createAppAPI`), `getApi()` 헬퍼. 메모리 절약을 위해 `homey-api/lib/HomeyAPI/HomeyAPI` 서브모듈 사용.
- `drivers/smartdoor/driver.js` — 페어링/복구 핸들러, 기기 목록(`homey:manager:api`), 카메라 검색, Flow 등록.
- `drivers/smartdoor/device.js` — `applyConfig`(capability 동기화·영상 등록·센서 구독), 도어락 미러/제어, 센서 초기값 반영.
- `lib/discovery.js` — ONVIF probe / `getRtspUri` / 포트 스캔.

## 요구 사항

- Homey firmware `>=12.4.0` (Videos API)
- 권한: `homey:manager:api` (연동 기기 목록·구독·제어)

## 개발 메모

- `homey app run` 은 개발 브리지에서 **repair 커스텀 뷰를 서빙하지 못하는 정황**이 있어, repair 확인은 `homey app install` 정식 설치로 검증.
- `homey app run` 은 핫리로드 안 됨 → 코드/HTML 변경 시 재시작 필요.
- 페어링 뷰에서 `onHomeyReady` 콜백이 안 뜨는 환경 대비: onHomeyReady + DOMContentLoaded + window load + 폴링으로 부트.

## 라이선스

GPL-3.0-or-later

## 개발자

Geunwon Mo
