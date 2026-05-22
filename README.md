# wkace-building-lookup

전사 고객 테이블 **건물 데이터 대량 조회·업데이트** 서비스

에어테이블 각 사업부 고객테이블의 `건물명(카카오)` + `주용도` 필드를
카카오 API + 건축물대장 API를 이용해 대량으로 표준화합니다.

## 처리 흐름

```
에어테이블 레코드 불러오기
  → 도로명 주소 기준으로 카카오 REST API 조회 (건물명(카카오) 확보)
  → 도로명주소 API 조회 (행정코드 변환)
  → 건축물대장 API 조회 (주용도 원본값 확보)
  → 주용도 7개 옵션으로 매핑
  → 관리자 검토 (변경 전/후 비교)
  → 선택 항목 에어테이블 일괄 업데이트
```

## 주용도 매핑 기준

| 건축물대장 원본 (일부) | 매핑 결과 |
|----------------------|----------|
| 공동주택(아파트), 연립주택 | 아파트 |
| 오피스텔 | 오피스텔 |
| 제1·2종근린생활시설, 판매시설 | 상가 |
| 업무시설 | 업무시설 |
| 공장, 지식산업센터 | 공장 |
| 교육연구시설, 학교 | 학교 |
| 그 외 | 기타 |

## 환경변수

| 변수 | 설명 |
|------|------|
| `JUSO_API_KEY` | 도로명주소 API 키 (행정안전부) |
| `BUILDING_API_KEY` | 건축물대장 API 키 (공공데이터포털) |
| `KAKAO_REST_API_KEY` | 카카오 REST API 키 |
| `AIRTABLE_API_KEY` | 에어테이블 Personal Access Token |

## 로컬 실행

```bash
npm install
cp .env.example .env
# .env 파일에 API 키 입력 후
npm start
# → http://localhost:3002
```

## Railway 배포

1. GitHub에 Push
2. Railway에서 GitHub repo 연결
3. Environment Variables에 4개 API 키 입력
4. 자동 배포 완료
