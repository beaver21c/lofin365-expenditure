#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
지도용 크로스워크 — 경계 데이터와 지방재정365를 잇는다.

두 코드 체계가 다르다는 것이 이 파일의 존재 이유다.

  경계(vuski)   11, 21, 22, 23, 24, 25, 26, 29, 31~39
  지방재정365   11, 26, 27, 28, 29, 30, 31, 32, 41~49

값이 겹치는데 뜻이 다르다. `26` 은 경계에서 울산, 지방재정365에서 부산이다.
숫자로 직접 이으면 오류 없이 **엉뚱한 지역에 색이 칠해진 지도**가 나온다.
그래서 이름으로 잇고, 매칭률을 검증하고, 못 맞춘 것을 전부 기록한다.

시군구는 한 겹 더 있다. 경계 데이터는 일반구까지 나뉘어 있어
'수원시장안구'처럼 4개로 쪼개져 있지만 지방재정365의 자치단체는 '수원시'
하나다. code_table 의 merged_cities 로 먼저 합친 뒤 이름을 맞춘다.
"""

from __future__ import annotations

import re
import json
import shutil
import logging
from pathlib import Path

log = logging.getLogger("lofin")

GEO_SRC = Path("web/vendor/geo")

# 매칭률이 이 아래로 떨어지면 지도를 만들지 않는다. 일부만 칠해진 지도는
# 빈 곳이 '예산 0' 으로 읽혀서, 아예 없느니만 못하다.
MIN_MATCH_RATE = 0.95


def sido_key(name: str) -> str:
    """시도명을 두 체계 공통의 짧은 형태로 줄인다."""
    n = re.sub(r"\s+", "", str(name))
    n = re.sub(r"(특별자치시|특별자치도|특별시|광역시|자치시|자치도|도)$", "", n)
    for full, short in (("충청북", "충북"), ("충청남", "충남"),
                        ("전라북", "전북"), ("전라남", "전남"),
                        ("경상북", "경북"), ("경상남", "경남")):
        if n.startswith(full):
            n = short + n[len(full):]
    return n


def sgg_key(name: str) -> str:
    """시군구명 정규화. 공백만 지운다 — 접미(시/군/구)는 의미가 있어 남긴다."""
    return re.sub(r"\s+", "", str(name))


def load_boundaries() -> dict:
    ct = json.loads((GEO_SRC / "code_table.json").read_text(encoding="utf-8"))
    return ct


def geo_units(ct: dict) -> dict[str, list[dict]]:
    """
    경계 데이터를 '자치단체 단위' 로 묶는다.

    일반구가 있는 시는 merged_cities 로 합쳐 하나로 만들고,
    나머지는 그대로 둔다. 결과의 각 단위는 sgg 코드를 여러 개 가질 수 있다.
    """
    merged = ct.get("merged_cities", {})
    out: dict[str, list[dict]] = {}
    for sido_cd, sgg_list in ct["sgg"].items():
        groups = merged.get(sido_cd, [])
        taken: set[str] = set()
        units = []
        for g in groups:
            units.append({"nm": g["name"], "sgg": list(g["sgg_codes"])})
            taken.update(g["sgg_codes"])
        for s in sgg_list:
            if s["code"] in taken:
                continue
            units.append({"nm": s["name"], "sgg": [s["code"]]})
        out[sido_cd] = units
    return out


def build(regions: list[dict], sido_list: list[dict], out_dir: Path) -> dict:
    """
    크로스워크를 만들고 경계 파일을 사이트에 복사한다.

    regions   매니페스트의 자치단체 목록 (cd, nm, sido, head)
    sido_list 매니페스트의 시도 목록 (cd, nm)
    """
    ct = load_boundaries()
    units = geo_units(ct)

    # ── 시도: 이름으로 잇는다
    geo_sido_by_key = {sido_key(s["name"]): s["code"] for s in ct["sido"]}
    sido_map: dict[str, dict] = {}
    sido_unmatched = []
    for s in sido_list:
        key = sido_key(s["nm"])
        geo = geo_sido_by_key.get(key)
        if geo:
            sido_map[s["cd"]] = {"geo": geo, "nm": s["nm"], "key": key}
        else:
            sido_unmatched.append(f"{s['cd']} {s['nm']} (정규화 '{key}')")

    if sido_unmatched:
        raise SystemExit(
            "시도 크로스워크 실패 — 이름을 맞추지 못한 시도가 있습니다:\n  "
            + "\n  ".join(sido_unmatched)
            + f"\n경계 데이터의 시도: {sorted(geo_sido_by_key)}"
        )
    log.info("  시도 크로스워크 %d/%d", len(sido_map), len(sido_list))

    # ── 시군구: 시도 안에서 이름으로 잇는다
    region_map: dict[str, dict] = {}
    unmatched: list[dict] = []
    used: dict[str, set] = {}

    basic = [r for r in regions if not r.get("head")]
    for r in basic:
        sm = sido_map.get(r["sido"])
        if not sm:
            unmatched.append({"cd": r["cd"], "nm": r["nm"], "why": "시도 미매칭"})
            continue
        geo_sido = sm["geo"]
        cand = units.get(geo_sido, [])
        key = sgg_key(r["nm"])
        hit = next((u for u in cand if sgg_key(u["nm"]) == key), None)
        if hit is None:
            unmatched.append({
                "cd": r["cd"], "nm": r["nm"], "sido": sm["nm"],
                "why": "이름 미매칭",
            })
            continue
        region_map[r["cd"]] = {"sido": geo_sido, "sgg": hit["sgg"], "nm": r["nm"]}
        used.setdefault(geo_sido, set()).update(hit["sgg"])

    rate = len(region_map) / len(basic) if basic else 0.0
    log.info("  시군구 크로스워크 %d/%d (%.2f%%)", len(region_map), len(basic), rate * 100)

    # 경계에는 있는데 재정 데이터에 없는 곳 — 지도에서 회색으로 남는다
    orphan = []
    for geo_sido, us in units.items():
        if geo_sido not in {v["geo"] for v in sido_map.values()}:
            continue
        for u in us:
            if not (set(u["sgg"]) & used.get(geo_sido, set())):
                orphan.append({"sido": geo_sido, "nm": u["nm"], "sgg": u["sgg"]})

    if unmatched:
        log.warning("  미매칭 자치단체 %d곳:", len(unmatched))
        for x in unmatched[:20]:
            log.warning("    %s %s (%s)", x["cd"], x["nm"], x["why"])
        if len(unmatched) > 20:
            log.warning("    … 외 %d곳", len(unmatched) - 20)
    if orphan:
        log.warning("  재정 데이터가 없는 경계 %d곳 (지도에서 회색): %s",
                    len(orphan), ", ".join(o["nm"] for o in orphan[:10]))

    available = rate >= MIN_MATCH_RATE
    if not available:
        log.error("  ★ 매칭률 %.1f%% 가 기준(%.0f%%) 미만이라 지도를 제공하지 않습니다.",
                  rate * 100, MIN_MATCH_RATE * 100)

    # ── 산출
    out_dir.mkdir(parents=True, exist_ok=True)
    if available:
        for f in ("sido.topojson", "sgg.topojson"):
            shutil.copy2(GEO_SRC / f, out_dir / f)

    crosswalk = {
        "schema": "geo/1",
        "available": available,
        "source": {
            "name": "vuski/admdongkor",
            "url": "https://github.com/vuski/admdongkor",
            "version": ct.get("meta", {}).get("source_version", ""),
            "license": "자유 이용 (출처 표기)",
        },
        "note": ("경계 데이터와 지방재정365는 시도 코드 체계가 다릅니다. "
                 "숫자가 아니라 이름으로 결합했습니다."),
        "sido": {cd: v["geo"] for cd, v in sido_map.items()},
        "sido_nm": {v["geo"]: v["nm"] for v in sido_map.values()},
        "region": region_map,
        "match": {
            "regions_total": len(basic),
            "regions_matched": len(region_map),
            "rate": round(rate, 4),
            "unmatched": unmatched,
            "boundary_without_data": orphan,
        },
    }
    blob = json.dumps(crosswalk, ensure_ascii=False, separators=(",", ":"))
    (out_dir / "crosswalk.json").write_text(blob, encoding="utf-8")

    warnings = []
    if unmatched:
        names = ", ".join(x["nm"] for x in unmatched[:5])
        warnings.append(
            f"지도에서 {len(unmatched)}곳의 경계를 찾지 못했습니다 ({names}"
            + (" 외" if len(unmatched) > 5 else "") + "). 해당 지역은 회색으로 표시됩니다.")
    if not available:
        warnings.append(
            f"경계 매칭률이 {rate:.1%} 로 낮아 지도를 제공하지 않습니다.")

    return {"crosswalk": crosswalk, "warnings": warnings, "available": available}
