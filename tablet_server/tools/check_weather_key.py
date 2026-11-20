"""기상청 단기예보 키 확인 도구(무료 API 2회 호출: 초단기실황 1 + 단기예보 1).

    python tablet_server/tools/check_weather_key.py          # 키를 붙여넣기(화면에 보이지 않음)
    MGFB_KMA_KEY=... python tablet_server/tools/check_weather_key.py

키는 출력·저장하지 않는다. 결과 코드와 받은 개수만 보여 준다.
"""
from __future__ import annotations

import getpass
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import weather  # noqa: E402


def main() -> int:
    key = os.environ.get("MGFB_KMA_KEY", "").strip() or getpass.getpass("공공데이터포털 일반 인증키(Decoding): ").strip()
    if not key:
        print("키가 없어요.")
        return 1
    now = datetime.now(timezone.utc)
    fetch = weather.http_fetcher(key)
    ok = True
    for op, (bd, bt), label in (("getUltraSrtNcst", weather.ncst_base(now), "초단기실황"), ("getVilageFcst", weather.fcst_base(now), "단기예보")):
        try:
            items = weather._items(fetch(op, {"base_date": bd, "base_time": bt, "nx": "60", "ny": "127"}))
            if op == "getUltraSrtNcst":
                p = weather.parse_ncst(items)
                print(f"[정상] {label} {bt[:2]}시 자료 {len(items)}개, 서울시청 기온 {p.get('tmp')}도")
            else:
                p = weather.parse_fcst(items)
                print(f"[정상] {label} {bt[:2]}시 발표, 시간별 예보 {len(p['hours'])}시간")
        except weather.WeatherError as e:
            ok = False
            print(f"[실패] {label}: {e}")
    print("이 키를 보드에 넣으면 돼요." if ok else "공공데이터포털 마이페이지에서 '기상청_단기예보 조회서비스' 활용 신청 여부를 확인해 주세요.")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
