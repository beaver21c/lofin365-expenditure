#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
1단계 측정 — 설계에 남아 있는 추정치를 실측값으로 바꾼다.

지금까지의 설계는 다음 값들을 추정에 의존하고 있다.
이 스크립트가 원자료에서 직접 재어 확정한다.

  · 자치단체 수와 광역 본청 판별 방법      → 분위 밴드의 모집단
  · 080·090 행 비중                        → 검색 파일 크기
  · 분야·부문 코드의 실제 목록             → 도넛 조각 수, 화면 구성
  · 지자체당 고유 세부사업명 수             → 사전 인코딩 효과
  · 재원 4항목 합 = 총액 성립 여부          → 재원 구성 표시 가능 여부
  · 연도별 실제 완전성                      → 수집기 0.99 임계값이 가린 누락

실제 지자체 하나의 검색 파일을 만들어 크기를 재므로,
추정이 아니라 측정된 바이트 수가 나온다.

사용: python scripts/measure.py --years 2024
"""

from __future__ import annotations

import io
import gzip
import json
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta

import pandas as pd

from lofin_common import (
    FOCUS_FIELDS, REQUIRED_COLS, USE_COLS,
    SourceRepoError, setup_logging, log,
    list_source_assets, year_asset_map, download_asset, fetch_progress,
    read_year_csv, field_of_part,
)

KST = timezone(timedelta(hours=9))
CACHE = Path(".cache")
OUT = Path("docs/measurement")


def head_office_mask(df: pd.DataFrame) -> pd.Series:
    """
    광역 본청 행을 가려낸다.

    본청 예산은 시군구와 성격이 달라, 시도 내 분위 밴드 모집단에
    섞이면 분포가 통째로 왜곡된다. 두 가지 신호를 함께 본다.
      · 자치단체명이 '본청'으로 끝난다
      · 자치단체 코드가 광역 코드와 같다 (기초가 아니라 광역 자신)
    """
    by_name = df["laf_hg_nm"].astype(str).str.endswith("본청")
    if "wa_laf_cd" in df.columns:
        by_code = df["laf_cd"].astype(str) == df["wa_laf_cd"].astype(str)
        return by_name | by_code
    return by_name


def measure_year(year: int, df: pd.DataFrame) -> dict:
    n_rows = len(df)
    focus = df[df["fld_cd"].isin(FOCUS_FIELDS)]

    # ── 자치단체
    head = head_office_mask(df)
    regions = df[["laf_cd", "laf_hg_nm"]].drop_duplicates()
    heads = df.loc[head, ["laf_cd", "laf_hg_nm"]].drop_duplicates()

    sido = {}
    if "wa_laf_cd" in df.columns:
        g = df[~head].groupby("wa_laf_hg_nm")["laf_cd"].nunique().sort_values(ascending=False)
        sido = {str(k): int(v) for k, v in g.items()}

    # ── 분야 · 부문
    fields = (
        df[["fld_cd", "fld_nm"]].drop_duplicates()
        .sort_values("fld_cd").to_dict("records")
    )
    parts = (
        focus[["fld_cd", "ane_part_cd", "part_nm"]].drop_duplicates()
        .sort_values(["fld_cd", "ane_part_cd"]).to_dict("records")
    )
    accounts = (
        df[["acnt_dv_cd", "acnt_dv_nm"]].drop_duplicates()
        .sort_values("acnt_dv_cd").to_dict("records")
    )

    # 부문 코드에서 상위 분야를 유도하는 규칙(앞 두 자리 공유)이
    # 실제 데이터와 맞는지 확인한다. 어긋나면 화면 계층 구성이 틀어진다.
    derived = focus["ane_part_cd"].map(field_of_part)
    part_rule_mismatch = int((derived != focus["fld_cd"]).sum())

    # ── 재원 항등식
    identity = None
    amt_cols = ["bdg_ntep", "capep", "sggep", "etc_amt"]
    if all(c in df.columns for c in amt_cols + ["bdg_cash_amt"]):
        parts_sum = df[amt_cols].sum(axis=1)
        diff = (parts_sum - df["bdg_cash_amt"]).abs()
        mismatch = int((diff > 0).sum())
        identity = {
            "checked_rows": n_rows,
            "mismatch_rows": mismatch,
            "mismatch_rate": round(mismatch / n_rows, 6) if n_rows else 0.0,
            "max_abs_diff": int(diff.max()) if n_rows else 0,
            "total_abs_diff": int(diff.sum()) if n_rows else 0,
        }

    # ── 사업 수 정의 차이 (고유 사업코드 vs 행 수)
    biz = {
        "focus_rows": len(focus),
        "focus_unique_dbiz": int(focus["dbiz_cd"].nunique()),
        "focus_unique_name": int(focus["dbiz_nm"].nunique()),
        "all_unique_dbiz": int(df["dbiz_cd"].nunique()),
    }

    return {
        "year": year,
        "rows": n_rows,
        "focus_rows": len(focus),
        "focus_share": round(len(focus) / n_rows, 4) if n_rows else 0.0,
        "regions_total": len(regions),
        "regions_head_office": len(heads),
        "regions_basic": len(regions) - len(heads),
        "head_office_names": sorted(heads["laf_hg_nm"].astype(str).tolist())[:25],
        "sido_region_counts": sido,
        "fields": fields,
        "focus_parts": parts,
        "accounts": accounts,
        "part_rule_mismatch_rows": part_rule_mismatch,
        "revenue_identity": identity,
        "biz": biz,
        "coerce_failed": int(df.attrs.get("coerce_failed", 0)),
        "columns_present": df.attrs.get("columns_present", []),
    }


def measure_search_payload(df: pd.DataFrame) -> dict:
    """
    검색 파일의 실제 크기를 잰다.

    추정하지 않고, 행 수가 중앙값인 지자체를 하나 골라
    실제로 사전 인코딩된 파일을 만들어 바이트를 센다.
    gzip 크기도 함께 재는데, GitHub Pages 가 전송 시 자동으로
    압축하므로 사용자가 실제로 받는 양은 그쪽이다.
    """
    focus = df[df["fld_cd"].isin(FOCUS_FIELDS)]
    if focus.empty:
        return {"error": "080·090 행이 없습니다"}

    head = head_office_mask(df)
    basic = focus[~head.reindex(focus.index, fill_value=False)]
    if basic.empty:
        basic = focus

    counts = basic.groupby("laf_cd").size().sort_values()
    if counts.empty:
        return {"error": "자치단체를 가려내지 못했습니다"}

    # 중앙값 지자체 — 최대·최소가 아니라 대표값을 본다
    mid_cd = counts.index[len(counts) // 2]
    sample = basic[basic["laf_cd"] == mid_cd]

    names = sorted(sample["dbiz_nm"].astype(str).unique())
    codes = sorted(sample["dbiz_cd"].astype(str).unique())
    parts = sorted(sample["ane_part_cd"].astype(str).unique())
    accts = sorted(sample["acnt_dv_cd"].astype(str).unique())
    ni = {v: i for i, v in enumerate(names)}
    ci = {v: i for i, v in enumerate(codes)}
    pi = {v: i for i, v in enumerate(parts)}
    ai = {v: i for i, v in enumerate(accts)}

    payload = {
        "schema": "biz/1",
        "region": str(mid_cd),
        "names": names,
        "codes": codes,
        "parts": parts,
        "accounts": accts,
        "y": [int(v) for v in sample["fyr"]],
        "p": [pi[v] for v in sample["ane_part_cd"].astype(str)],
        "a": [ai[v] for v in sample["acnt_dv_cd"].astype(str)],
        "nm": [ni[v] for v in sample["dbiz_nm"].astype(str)],
        "bc": [ci[v] for v in sample["dbiz_cd"].astype(str)],
        "bdg": [int(v) for v in sample["bdg_cash_amt"]],
    }
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz = gzip.compress(blob, 6)

    # 대조군 — 사전 인코딩을 하지 않았을 때의 크기
    naive = json.dumps(
        sample[["fyr", "ane_part_cd", "dbiz_nm", "dbiz_cd", "bdg_cash_amt"]]
        .to_dict("records"),
        ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")

    return {
        "sample_region": str(mid_cd),
        "sample_region_name": str(sample["laf_hg_nm"].iloc[0]),
        "rows_one_year": len(sample),
        "unique_names": len(names),
        "unique_codes": len(codes),
        "name_reuse_ratio": round(len(sample) / max(len(names), 1), 2),
        "bytes_encoded": len(blob),
        "bytes_encoded_gzip": len(gz),
        "bytes_naive": len(naive),
        "reduction_vs_naive": round(1 - len(blob) / max(len(naive), 1), 3),
        "region_count": len(counts),
        "rows_min": int(counts.iloc[0]),
        "rows_median": int(counts.iloc[len(counts) // 2]),
        "rows_max": int(counts.iloc[-1]),
    }


def project_totals(per_year: list[dict], search: dict, n_years: int) -> dict:
    """측정한 1개년 값에서 10개년 전체 규모를 산출한다."""
    if not per_year or "error" in search:
        return {}
    y = per_year[0]
    per_region_year = search["bytes_encoded"]
    regions = search["region_count"]

    # 연도가 늘어도 사전은 크게 늘지 않는다(같은 사업이 반복되므로).
    # 행 부분만 연도수에 비례한다고 보고, 사전은 1.6배 정도로 잡는다.
    rows_part = per_region_year * 0.75
    dict_part = per_region_year * 0.25
    per_region_all = rows_part * n_years + dict_part * 1.6

    return {
        "years": n_years,
        "regions": regions,
        "biz_file_bytes_est": int(per_region_all),
        "biz_file_gzip_est": int(per_region_all * search["bytes_encoded_gzip"] / max(search["bytes_encoded"], 1)),
        "biz_total_bytes_est": int(per_region_all * regions),
        "focus_rows_all_years_est": int(y["focus_rows"] * n_years),
    }


def render_report(result: dict) -> str:
    L: list[str] = []
    A = L.append
    m = result["measured_years"][0] if result["measured_years"] else {}
    s = result.get("search_payload", {})
    p = result.get("projection", {})

    A("# 원자료 측정 결과")
    A("")
    A(f"- 측정 시각: {result['measured_at']}")
    A(f"- 원자료 저장소: `{result['source_repo']}`")
    A(f"- 측정 연도: {', '.join(str(x['year']) for x in result['measured_years'])}")
    A("")
    A("이 문서는 `scripts/measure.py` 가 원자료에서 직접 측정해 생성한다. 손으로 고치지 않는다.")
    A("")

    # 수집 현황
    A("## 수집 현황")
    A("")
    ya = result.get("year_assets", {})
    if ya:
        A("| 연도 | 파일 | 용량 | 상태 |")
        A("|---|---|---:|---|")
        for yr, meta in ya.items():
            A(f"| {yr} | `{meta['name']}` | {meta['size']/1e6:,.1f} MB | "
              f"{'불완전' if meta['incomplete'] else '완전'} |")
        A("")
    prog = result.get("progress_check")
    if prog:
        A("### 연도별 완전성 검산")
        A("")
        A("수집기가 완전성 0.99 이상을 '완전'으로 기록하므로, 최대 1%까지는")
        A("누락된 채 완전으로 남을 수 있다. `progress.json` 의 수집 건수와 전체 건수를 대조한 결과다.")
        A("")
        A("| 연도 | 수집 | 전체 | 완전성 | 누락 |")
        A("|---|---:|---:|---:|---:|")
        for row in prog:
            flag = "" if row["complete"] else " ⚠"
            A(f"| {row['year']} | {row['count']:,} | {row['total']:,} | "
              f"{row['completeness']:.4%}{flag} | {row['missing']:,} |")
        A("")
        bad = [r for r in prog if not r["complete"]]
        if bad:
            A(f"**{len(bad)}개 연도가 100% 미만이다.** 해당 연도의 누락분은 특정 지자체·부문에")
            A("편중되어 있을 수 있으므로, 매니페스트에 기록해 화면에 노출한다.")
        else:
            A("모든 연도가 100% 수집되었다.")
        A("")

    if not m:
        return "\n".join(L)

    # 규모
    A("## 규모")
    A("")
    A("| 항목 | 값 |")
    A("|---|---:|")
    A(f"| 측정 연도 행 수 | {m['rows']:,} |")
    A(f"| 080·090 행 수 | {m['focus_rows']:,} |")
    A(f"| **080·090 행 비중** | **{m['focus_share']:.1%}** |")
    A(f"| 자치단체 수(전체) | {m['regions_total']:,} |")
    A(f"| 광역 본청 | {m['regions_head_office']:,} |")
    A(f"| 기초 자치단체 | {m['regions_basic']:,} |")
    A(f"| 고유 세부사업 코드(080·090) | {m['biz']['focus_unique_dbiz']:,} |")
    A(f"| 고유 세부사업명(080·090) | {m['biz']['focus_unique_name']:,} |")
    A("")
    A(f"사업 수를 사업코드 고유 개수로 세면 {m['biz']['focus_unique_dbiz']:,}개, "
      f"행 수로 세면 {m['focus_rows']:,}건이다. "
      f"차이가 {m['focus_rows'] - m['biz']['focus_unique_dbiz']:,}건인데 "
      "같은 사업이 회계·부문별로 나뉘어 계상된 결과다. 화면 기본값은 고유 개수를 쓴다.")
    A("")

    # 검색 파일
    if "error" not in s:
        A("## 검색 파일 크기 (실측)")
        A("")
        A(f"행 수가 중앙값인 지자체(`{s['sample_region']}` {s['sample_region_name']})로 "
          "실제 파일을 만들어 측정했다.")
        A("")
        A("| 항목 | 값 |")
        A("|---|---:|")
        A(f"| 1개년 행 수 | {s['rows_one_year']:,} |")
        A(f"| 고유 사업명 | {s['unique_names']:,} |")
        A(f"| 사업명 재사용 배수 | {s['name_reuse_ratio']}× |")
        A(f"| 사전 인코딩 없이 | {s['bytes_naive']/1024:,.0f} KB |")
        A(f"| **사전 인코딩 후** | **{s['bytes_encoded']/1024:,.0f} KB** |")
        A(f"| gzip 전송 시 | {s['bytes_encoded_gzip']/1024:,.0f} KB |")
        A(f"| 절감률 | {s['reduction_vs_naive']:.0%} |")
        A("")
        A(f"지자체별 행 수 분포: 최소 {s['rows_min']:,} / 중앙값 {s['rows_median']:,} / "
          f"최대 {s['rows_max']:,} (1개년 기준)")
        A("")
        if p:
            A("### 전체 규모 산출")
            A("")
            A("| 항목 | 값 |")
            A("|---|---:|")
            A(f"| 지자체 1곳 {p['years']}개년 파일 | {p['biz_file_bytes_est']/1024:,.0f} KB |")
            A(f"| 같은 파일 gzip 전송 | **{p['biz_file_gzip_est']/1024:,.0f} KB** |")
            A(f"| 전체 {p['regions']}개 지자체 합계 | **{p['biz_total_bytes_est']/1e6:,.0f} MB** |")
            A("")
            total_mb = p['biz_total_bytes_est'] / 1e6
            if total_mb < 400:
                A(f"GitHub Pages 사이트 한도가 1GB이므로 {total_mb:,.0f}MB 는 여유가 있다. "
                  "브라우저는 선택한 지자체 파일 하나만 받는다.")
            else:
                A(f"⚠ {total_mb:,.0f}MB 는 Pages 한도(1GB)에 근접한다. "
                  "시도별 분할 또는 저장 시 gzip 적용을 검토한다.")
            A("")

    # 분야 · 부문
    A("## 분야 · 부문 코드 (데이터에서 추출)")
    A("")
    A("추정하지 않고 원자료에서 그대로 뽑은 목록이다. 화면 구성은 이 목록을 따른다.")
    A("")
    A("| 분야 | 분야명 |")
    A("|---|---|")
    for f in m["fields"]:
        mark = " ★" if f["fld_cd"] in FOCUS_FIELDS else ""
        A(f"| `{f['fld_cd']}` | {f['fld_nm']}{mark} |")
    A("")
    A(f"★ 표시가 분석 대상이다. 분야 총 {len(m['fields'])}종.")
    A("")
    A("| 분야 | 부문 | 부문명 |")
    A("|---|---|---|")
    for pt in m["focus_parts"]:
        A(f"| `{pt['fld_cd']}` | `{pt['ane_part_cd']}` | {pt['part_nm']} |")
    A("")
    n_parts = len(m["focus_parts"])
    A(f"080·090의 부문은 총 {n_parts}종이다. "
      + ("도넛 조각으로 무리 없는 수다." if n_parts <= 12 else
         f"12종을 넘으므로 하위 부문을 '기타'로 묶는 처리가 필요하다."))
    A("")
    if m["part_rule_mismatch_rows"]:
        A(f"⚠ 부문 코드 앞 두 자리로 상위 분야를 유도하는 규칙이 "
          f"{m['part_rule_mismatch_rows']:,}행에서 어긋난다. 계층 구성은 유도 규칙이 아니라 "
          "원자료의 `fld_cd` 를 그대로 써야 한다.")
    else:
        A("부문 코드의 앞 두 자리가 상위 분야와 모두 일치한다. 계층 구성이 안전하다.")
    A("")
    A("| 회계구분 | 명칭 |")
    A("|---|---|")
    for a in m["accounts"]:
        A(f"| `{a['acnt_dv_cd']}` | {a['acnt_dv_nm']} |")
    A("")

    # 재원 항등식
    A("## 재원 항등식")
    A("")
    ri = m.get("revenue_identity")
    if ri:
        A(f"`국비 + 시도비 + 시군구비 + 기타 = 예산액` 을 {ri['checked_rows']:,}행 전량에 대해 검사했다.")
        A("")
        A("| 항목 | 값 |")
        A("|---|---:|")
        A(f"| 불일치 행 | {ri['mismatch_rows']:,} |")
        A(f"| 불일치율 | {ri['mismatch_rate']:.4%} |")
        A(f"| 최대 차액 | {ri['max_abs_diff']:,} 원 |")
        A("")
        if ri["mismatch_rate"] > 0.01:
            A("**⚠ 불일치율이 1%를 넘는다.** 재원 필드의 의미 추정이 틀렸을 가능성이 있다. "
              "재원 구성 표시 기능은 보류하고 확인이 필요하다.")
        elif ri["mismatch_rows"]:
            A("불일치율이 1% 미만이다. 재원 구성을 표시하되 이 수치를 매니페스트에 남긴다.")
        else:
            A("전량 일치한다. 재원 구성을 그대로 표시해도 된다.")
    else:
        A("재원 컬럼이 없어 검사하지 못했다.")
    A("")

    # 자치단체
    A("## 자치단체 구성")
    A("")
    A(f"광역 본청으로 판별된 것이 {m['regions_head_office']}개다. "
      "이들은 시도 내 분위 밴드 모집단에서 제외한다 — 예산 성격이 시군구와 달라 "
      "분포를 왜곡하기 때문이다.")
    A("")
    if m["head_office_names"]:
        A("판별된 본청(일부): " + ", ".join(f"`{n}`" for n in m["head_office_names"]))
        A("")
    if m["sido_region_counts"]:
        A("### 시도별 기초자치단체 수")
        A("")
        A("분위 밴드의 모집단 크기다. 5곳 미만이면 밴드를 그리지 않는다.")
        A("")
        A("| 시도 | 기초 수 | 밴드 |")
        A("|---|---:|---|")
        for k, v in m["sido_region_counts"].items():
            A(f"| {k} | {v} | {'가능' if v >= 5 else '**불가 (표본 부족)**'} |")
        A("")
        small = [k for k, v in m["sido_region_counts"].items() if v < 5]
        if small:
            A(f"**{', '.join(small)}** 은 모집단이 5곳 미만이라 분위 밴드를 표시하지 않고 "
              "사유를 화면에 적는다.")
            A("")

    # 데이터 품질
    A("## 데이터 품질")
    A("")
    A(f"- 금액 컬럼 변환 실패: {m['coerce_failed']:,}건")
    A(f"- 실제 컬럼 {len(m['columns_present'])}종: "
      + ", ".join(f"`{c}`" for c in m["columns_present"]))
    A("")

    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description="원자료 측정")
    ap.add_argument("--years", type=int, nargs="+", default=None,
                    help="측정할 연도. 기본은 가장 최근 1개년")
    ap.add_argument("--source-repo", default=None)
    args = ap.parse_args()

    setup_logging()
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)

    assets = list_source_assets(args.source_repo)
    ymap = year_asset_map(assets)
    if not ymap:
        raise SourceRepoError("연도별 원자료 CSV 를 찾지 못했습니다.")
    log.info("원자료 연도: %s", ", ".join(str(y) for y in ymap))

    # 완전성 검산
    progress_check = None
    try:
        prog = fetch_progress(args.source_repo)
        if prog:
            rows = []
            for y, info in sorted(prog.get("completed_years", {}).items()):
                count = int(info.get("count", 0))
                total = int(info.get("total_count", 0)) or count
                rows.append({
                    "year": int(y), "count": count, "total": total,
                    "completeness": count / total if total else 0.0,
                    "missing": max(total - count, 0),
                    "complete": count >= total,
                })
            progress_check = rows
    except SourceRepoError:
        raise
    except Exception as e:  # 검산 실패가 측정 전체를 막지는 않게 한다
        log.warning("완전성 검산 실패: %s", e)

    targets = args.years or [max(ymap)]
    measured, search, projection = [], {}, {}

    for year in targets:
        if year not in ymap:
            log.warning("%d년 원자료가 없습니다 — 건너뜁니다", year)
            continue
        meta = ymap[year]
        log.info("=" * 60)
        log.info("%d년 측정 (%s, %.1f MB)", year, meta["name"], meta["size"] / 1e6)
        path = download_asset(meta["id"], CACHE / meta["name"], args.source_repo, meta["size"])

        df = read_year_csv(path)
        log.info("  읽음: %d행 × %d열", len(df), len(df.columns))

        measured.append(measure_year(year, df))
        if not search:
            search = measure_search_payload(df)
            log.info("  검색 파일 실측: %s → %.0f KB (gzip %.0f KB)",
                     search.get("sample_region_name", "?"),
                     search.get("bytes_encoded", 0) / 1024,
                     search.get("bytes_encoded_gzip", 0) / 1024)
        del df

    if measured and search:
        projection = project_totals(measured, search, len(ymap))

    result = {
        "measured_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST"),
        "source_repo": args.source_repo or "beaver21c/lofin365-expenditure-collector",
        "year_assets": {str(y): m for y, m in ymap.items()},
        "progress_check": progress_check,
        "measured_years": measured,
        "search_payload": search,
        "projection": projection,
    }

    (OUT / "measurement.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "MEASUREMENT.md").write_text(render_report(result), encoding="utf-8")

    log.info("=" * 60)
    log.info("완료 → %s", OUT / "MEASUREMENT.md")
    if measured:
        m = measured[0]
        log.info("  080·090 행 비중: %.1f%%", m["focus_share"] * 100)
        log.info("  자치단체: 전체 %d (본청 %d, 기초 %d)",
                 m["regions_total"], m["regions_head_office"], m["regions_basic"])
        log.info("  080·090 부문: %d종", len(m["focus_parts"]))
    if projection:
        log.info("  검색 데이터 전체: 약 %.0f MB", projection["biz_total_bytes_est"] / 1e6)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SourceRepoError as e:
        print(f"\n{'='*60}\n{e}\n{'='*60}\n", file=__import__("sys").stderr)
        raise SystemExit(2)
