#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
합성 데이터로 _site 를 만든다. 원자료 접근 없이 화면을 확인하고 검증하기 위한 것이다.

실제 집계 코드(aggregate.py)의 직렬화 함수를 그대로 거치므로,
여기서 만들어진 파일은 실제 빌드 산출물과 같은 형식이다.
숫자만 가짜다.

사용: python scripts/make_fixture.py
"""

from __future__ import annotations

import shutil
import random
from pathlib import Path
from datetime import datetime, timezone, timedelta

import pandas as pd

import aggregate as AG
import build_geo
from lofin_common import FOCUS_FIELDS

KST = timezone(timedelta(hours=9))
SITE = Path("_site")
YEARS = list(range(2016, 2026))

# 시도 코드와 시군구 이름을 실제 값으로 쓴다. 지도 크로스워크가
# 이름으로 결합하므로, 가짜 이름을 쓰면 그 경로를 검증할 수 없다.
# 지방재정365의 시도 코드 체계는 경계 데이터와 다르다(11/26/27… vs 11/21/22…).
LOFIN_SIDO = [
    ("1100000", "서울"), ("2600000", "부산"), ("2700000", "대구"),
    ("2800000", "인천"), ("2900000", "광주"), ("3000000", "대전"),
    ("3100000", "울산"), ("3200000", "세종"), ("4100000", "경기"),
    ("4200000", "강원"), ("4300000", "충북"), ("4400000", "충남"),
    ("4500000", "전북"), ("4600000", "전남"), ("4700000", "경북"),
    ("4800000", "경남"), ("4900000", "제주"),
]


def real_units():
    """경계 데이터에서 실제 시군구 이름을 가져온다."""
    ct = build_geo.load_boundaries()
    units = build_geo.geo_units(ct)
    geo_by_key = {build_geo.sido_key(x["name"]): x["code"] for x in ct["sido"]}
    out = []
    for cd, nm in LOFIN_SIDO:
        g = geo_by_key[build_geo.sido_key(nm)]
        names = [u["nm"] for u in units[g]]
        out.append((cd, nm, names))
    return out


SIDO = [(cd, nm, len(names)) for cd, nm, names in real_units()]
SIDO_NAMES = {cd: names for cd, nm, names in real_units()}
FIELDS = [
    ("010", "일반공공행정"), ("020", "공공질서및안전"), ("050", "교육"),
    ("060", "문화및관광"), ("070", "환경"), ("080", "사회복지"),
    ("090", "보건"), ("100", "농림해양수산"), ("110", "산업·중소기업"),
    ("120", "교통및물류"), ("140", "국토및지역개발"), ("150", "과학기술"),
]
PARTS = [
    ("081", "기초생활보장", "080"), ("082", "취약계층지원", "080"),
    ("083", "보육·가족및여성", "080"), ("084", "노인·청소년", "080"),
    ("085", "노동", "080"), ("086", "보훈", "080"),
    ("091", "보건의료", "090"), ("092", "식품의약안전", "090"),
]
ACCOUNTS = [("100", "일반회계"), ("200", "기타특별회계"), ("300", "기금")]
BIZ_WORDS = [
    "노인일자리 및 사회활동 지원", "기초연금", "아동수당", "영유아 보육료 지원",
    "장애인 활동지원", "노인맞춤돌봄서비스", "생계급여", "의료급여",
    "치매안심센터 운영", "지역사회 통합돌봄", "청년 일자리 지원",
    "가정양육수당", "장애인 연금", "노인복지관 운영", "정신건강복지센터 운영",
    "감염병 대응", "방문건강관리사업", "국가예방접종 지원",
]


def make_frame(year: int, rng: random.Random) -> pd.DataFrame:
    rows = []
    for sido_cd, sido_nm, n in SIDO:
        # 본청은 항상 하나
        units = [(sido_cd, f"{sido_nm}본청", True)]
        for i, sgg_nm in enumerate(SIDO_NAMES[sido_cd]):
            cd = f"{sido_cd[:2]}{i+1:02d}000"
            units.append((cd, sgg_nm, False))

        for laf_cd, laf_nm, head in units:
            scale = (6 if head else 1) * rng.uniform(0.4, 2.6)
            growth = 1 + (year - 2016) * rng.uniform(0.02, 0.09)
            for fld_cd, fld_nm in FIELDS:
                is_focus = fld_cd in FOCUS_FIELDS
                # 사회복지가 가장 큰 분야가 되도록
                weight = 5.0 if fld_cd == "080" else (0.7 if fld_cd == "090" else rng.uniform(0.3, 1.4))
                parts = [p for p in PARTS if p[2] == fld_cd] or [(fld_cd, fld_nm, fld_cd)]
                for part_cd, part_nm, _ in parts:
                    for acnt_cd, acnt_nm in ACCOUNTS:
                        if acnt_cd != "100" and rng.random() > 0.35:
                            continue
                        n_biz = rng.randint(2, 7) if is_focus else rng.randint(1, 3)
                        for b in range(n_biz):
                            amt = int(rng.uniform(2e8, 9e10) * scale * weight * growth)
                            ntep = int(amt * rng.uniform(0, 0.7))
                            capep = int((amt - ntep) * rng.uniform(0, 0.6))
                            sggep = int((amt - ntep - capep) * rng.uniform(0, 0.9))
                            etc = amt - ntep - capep - sggep
                            name = (rng.choice(BIZ_WORDS) if is_focus
                                    else f"{part_nm} 사업 {b+1}")
                            rows.append({
                                "fyr": str(year),
                                "wa_laf_cd": sido_cd, "wa_laf_hg_nm": sido_nm,
                                "laf_cd": laf_cd, "laf_hg_nm": laf_nm,
                                "acnt_dv_cd": acnt_cd, "acnt_dv_nm": acnt_nm,
                                "fld_cd": fld_cd, "fld_nm": fld_nm,
                                "ane_part_cd": part_cd, "part_nm": part_nm,
                                "dbiz_cd": f"{laf_cd}{fld_cd}{part_cd}{b:04d}",
                                "dbiz_nm": name,
                                "padm_laf_cd": sido_cd, "zon_cd": sido_cd[:2],
                                "bdg_cash_amt": amt, "bdg_ntep": ntep,
                                "capep": capep, "sggep": sggep, "etc_amt": etc,
                                "ep_amt": int(amt * rng.uniform(0.75, 0.99)),
                            })
    df = pd.DataFrame(rows)
    # 실제 원자료에는 부문·회계 코드가 빈 행이 섞여 있다. 그 경로가
    # 화면까지 무사히 흘러가는지 확인해야 하므로 일부러 넣는다.
    if len(df) > 200:
        blanks = df.sample(n=max(len(df) // 200, 1), random_state=7).index
        df.loc[blanks, "ane_part_cd"] = None
        df.loc[blanks, "part_nm"] = None
    df.attrs["coerce_failed"] = 0
    df.attrs["missing_codes"] = {"ane_part_cd": int(df["ane_part_cd"].isna().sum())}
    # read_year_csv 가 하는 정규화를 그대로 적용한다
    for c in ("ane_part_cd", "part_nm"):
        df[c] = df[c].astype("string").fillna("").astype(object)
    return df


def main() -> int:
    rng = random.Random(20260811)
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir(parents=True)

    tots, dets, bizs, regs = [], [], [], []
    year_stats, region_years = {}, {}
    names_acc = {"fields": {}, "parts": {}, "accounts": {}}

    for year in YEARS:
        df = make_frame(year, rng)
        # 결측 연도를 하나 만들어 '선 끊김'을 확인할 수 있게 한다
        if year == 2019:
            df = df[df["laf_cd"] != "4102000"]
        tot, det, biz, stats = AG.aggregate_year(df)
        tots.append(tot); dets.append(det); bizs.append(biz)
        regs.append(stats["regions"])
        for cd in stats["regions"]["laf_cd"].astype(str):
            region_years.setdefault(cd, set()).add(year)
        for k, pairs in stats["names"].items():
            for row in pairs:
                names_acc[k][str(row[0])] = row
        year_stats[year] = {
            "rows": stats["rows"], "focus_rows": stats["focus_rows"],
            "identity_mismatch": stats.get("identity_mismatch"),
            "coerce_failed": 0, "incomplete_asset": False,
        }
        print(f"{year}: {stats['rows']:,}행 → 총액 {len(tot):,} / 상세 {len(det):,} / 사업 {len(biz):,}")

    tot_all = pd.concat(tots, ignore_index=True)
    det_all = pd.concat(dets, ignore_index=True)
    biz_all = pd.concat(bizs, ignore_index=True)
    reg_all = pd.concat(regs, ignore_index=True).drop_duplicates("laf_cd")
    reg_all["type"] = reg_all["laf_hg_nm"].map(AG.region_type)
    reg_all["_sido"] = reg_all["wa_laf_cd"].astype(str)
    reg_all["_sido_nm"] = reg_all["wa_laf_hg_nm"].astype(str)
    reg_all = reg_all.sort_values("laf_cd").reset_index(drop=True)

    data = SITE / "data"
    agg_sizes = {}
    for sido_cd, group in reg_all.groupby("_sido"):
        codes = set(group["laf_cd"].astype(str))
        t = tot_all[tot_all["laf_cd"].astype(str).isin(codes)]
        d = det_all[det_all["laf_cd"].astype(str).isin(codes)]
        if t.empty and d.empty:
            continue
        agg_sizes[sido_cd] = AG.write_json(
            data / "agg" / f"{sido_cd}.json", AG.build_sido_file(sido_cd, t, d, group))

    biz_sizes = {}
    for region_cd, group in biz_all.groupby(biz_all["laf_cd"].astype(str)):
        biz_sizes[region_cd] = AG.write_json(
            data / "biz" / f"{region_cd}.json", AG.build_biz_file(region_cd, group))

    sido_list = [{"cd": cd, "nm": str(g["_sido_nm"].iloc[0]),
                  "n_region": int((~g["head"]).sum())}
                 for cd, g in reg_all.groupby("_sido")]
    region_list = [{"cd": str(r["laf_cd"]), "nm": str(r["laf_hg_nm"]),
                    "sido": str(r["_sido"]), "type": str(r["type"]),
                    "head": bool(r["head"]),
                    "years": sorted(region_years.get(str(r["laf_cd"]), []))}
                   for _, r in reg_all.iterrows()]
    import logging; logging.basicConfig(level=logging.INFO, format="%(message)s")
    geo = build_geo.build(region_list, sido_list, data / "geo")

    manifest = {
        "schema_version": AG.SCHEMA_VERSION,
        "built_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST"),
        "source": {
            "api": "지방재정365 세부사업별 세출현황 (QWGJK) — 합성 데이터",
            "basis": "각 회계연도 12월 31일 기준",
            "note": "이 화면은 형식 확인용 합성 데이터입니다. 실제 값이 아닙니다.",
        },
        "focus_fields": list(FOCUS_FIELDS),
        "years": [{"y": y, "rows": year_stats[y]["rows"],
                   "focus_rows": year_stats[y]["focus_rows"],
                   "completeness": 1.0 if y != 2017 else 0.9971,
                   "missing": 0 if y != 2017 else 1012,
                   "asset_incomplete": False} for y in YEARS],
        "sido": sido_list,
        "regions": region_list,
        "geo": {"available": geo["available"],
                "match_rate": geo["crosswalk"]["match"]["rate"],
                "matched": geo["crosswalk"]["match"]["regions_matched"],
                "total": geo["crosswalk"]["match"]["regions_total"],
                "source": geo["crosswalk"]["source"]},
        "fields": [{"cd": cd, "nm": str(row[1])} for cd, row in sorted(names_acc["fields"].items())],
        "parts": [{"cd": cd, "nm": str(row[1]), "fld": str(row[2])}
                  for cd, row in sorted(names_acc["parts"].items())],
        "accounts": [{"cd": cd, "nm": str(row[1])} for cd, row in sorted(names_acc["accounts"].items())],
        "files": {"agg": "data/agg/{sido}.json", "biz": "data/biz/{region}.json"},
        "sizes": {
            "agg_total_bytes": sum(agg_sizes.values()),
            "biz_total_bytes": sum(biz_sizes.values()),
            "biz_files": len(biz_sizes),
            "biz_avg_bytes": int(sum(biz_sizes.values()) / max(len(biz_sizes), 1)),
            "biz_max_bytes": max(biz_sizes.values()) if biz_sizes else 0,
        },
        "validation": {"revenue_identity_mismatch_rows": 0,
                       "revenue_identity_mismatch_rate": 0.0, "coerce_failed": 0},
        "warnings": ["합성 데이터입니다. 실제 예산 값이 아닙니다.",
                     "2017년 원자료가 1,012건 누락되었습니다 (수집률 99.71%)."],
    }
    AG.write_json(data / "manifest.json", manifest)

    for item in AG.WEB.iterdir():
        dest = SITE / item.name
        shutil.copytree(item, dest) if item.is_dir() else shutil.copy2(item, dest)

    total = sum(f.stat().st_size for f in SITE.rglob("*") if f.is_file())
    print(f"\n_site 생성: {total/1e6:.1f} MB")
    print(f"  시도 집계 {len(agg_sizes)}개, 평균 {sum(agg_sizes.values())/max(len(agg_sizes),1)/1024:.0f} KB")
    print(f"  세부사업 {len(biz_sizes)}개, 평균 {sum(biz_sizes.values())/max(len(biz_sizes),1)/1024:.0f} KB, "
          f"최대 {max(biz_sizes.values())/1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
