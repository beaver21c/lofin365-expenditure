#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
2단계 집계 — 원자료를 대시보드가 읽는 형태로 바꾼다.

산출물은 저장소에 커밋하지 않는다. 빌드할 때마다 _site/ 를 새로 만들고
Actions 아티팩트로 Pages 에 배포한다. 커밋하면 git 이 모든 버전을 영구
보관해서, 재빌드를 반복할수록 저장소가 되돌릴 수 없이 불어난다.

_site/data/
  manifest.json      대시보드가 가장 먼저 읽는다. 선택 가능한 값이 전부 여기서 나온다
  agg/{시도}.json     예산 집계. 시도 단위로 나눠 선택한 시도만 받는다
  biz/{지자체}.json   세부사업. 선택한 지자체 하나만 받는다

집계 순서에 한 가지 지켜야 할 것이 있다.
080·090 으로 거르기 **전에** 전 분야 총액을 먼저 집계해야 한다.
비중(%) 의 분모가 전 분야 세출이기 때문에, 순서를 바꾸면 분모가 사라져
퍼센트 전환 기능이 통째로 불가능해진다.
"""

from __future__ import annotations

import gc
import json
import shutil
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta

import pandas as pd

import build_geo
from lofin_common import (
    FOCUS_FIELDS, SourceRepoError, setup_logging, log,
    list_source_assets, year_asset_map, download_asset, fetch_progress,
    read_year_csv, uniq_str,
)

KST = timezone(timedelta(hours=9))
CACHE = Path(".cache")
SITE = Path("_site")
WEB = Path("web")

SCHEMA_VERSION = "1.0"

# 집계 키. 회계구분을 키에 남겨 두어야 화면에서 회계 범위를 바꿀 때
# 재집계 없이 합산만 다시 하면 된다.
TOT_KEYS = ["fyr", "laf_cd", "acnt_dv_cd", "fld_cd"]
DET_KEYS = ["fyr", "laf_cd", "acnt_dv_cd", "fld_cd", "ane_part_cd"]

MONEY = {
    "bdg": "bdg_cash_amt", "ntep": "bdg_ntep", "capep": "capep",
    "sggep": "sggep", "etc": "etc_amt", "exec": "ep_amt",
}


def is_head_office(laf_cd: pd.Series, wa_laf_cd: pd.Series | None,
                   laf_nm: pd.Series) -> pd.Series:
    """광역 본청 판별. 분위 밴드 모집단에서 제외하기 위한 것이다."""
    by_name = laf_nm.astype(str).str.endswith("본청")
    if wa_laf_cd is not None:
        return by_name | (laf_cd.astype(str) == wa_laf_cd.astype(str))
    return by_name


def aggregate_year(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict]:
    """한 해치를 집계한다. (전분야 총액, 080·090 상세, 세부사업, 검증)"""
    stats: dict = {"rows": len(df)}

    # ── 검증: 재원 항등식. 필드 의미 추정이 맞는지 전량 확인한다.
    src = ["bdg_ntep", "capep", "sggep", "etc_amt"]
    if all(c in df.columns for c in src):
        diff = (df[src].sum(axis=1) - df["bdg_cash_amt"]).abs()
        stats["identity_mismatch"] = int((diff > 0).sum())
        stats["identity_max_diff"] = int(diff.max()) if len(df) else 0
    stats["coerce_failed"] = int(df.attrs.get("coerce_failed", 0))

    # ── 1) 전 분야 총액 — 반드시 필터 전에. 퍼센트의 분모다.
    money_present = {k: v for k, v in MONEY.items() if v in df.columns}
    tot = (
        df.groupby(TOT_KEYS, observed=True)
        .agg(bdg=("bdg_cash_amt", "sum"))
        .reset_index()
    )

    # ── 2) 080·090 부문별 상세
    focus = df[df["fld_cd"].isin(FOCUS_FIELDS)]
    agg_spec = {k: (v, "sum") for k, v in money_present.items()}
    agg_spec["nbiz"] = ("dbiz_cd", "nunique")
    agg_spec["nrow"] = ("dbiz_cd", "size")
    det = focus.groupby(DET_KEYS, observed=True).agg(**agg_spec).reset_index()

    # ── 3) 세부사업 — 검색용. 필요한 컬럼만 남긴다.
    biz_cols = ["fyr", "laf_cd", "acnt_dv_cd", "ane_part_cd",
                "dbiz_cd", "dbiz_nm", "bdg_cash_amt"]
    if "ep_amt" in focus.columns:
        biz_cols.append("ep_amt")
    biz = focus[[c for c in biz_cols if c in focus.columns]].copy()

    # ── 4) 자치단체 정보
    reg_cols = ["laf_cd", "laf_hg_nm"]
    for c in ("wa_laf_cd", "wa_laf_hg_nm", "zon_cd", "padm_laf_cd"):
        if c in df.columns:
            reg_cols.append(c)
    regions = df[reg_cols].drop_duplicates("laf_cd").copy()
    regions["head"] = is_head_office(
        regions["laf_cd"],
        regions["wa_laf_cd"] if "wa_laf_cd" in regions.columns else None,
        regions["laf_hg_nm"],
    )

    # ── 5) 코드 사전
    names = {
        "fields": df[["fld_cd", "fld_nm"]].drop_duplicates().values.tolist()
        if "fld_nm" in df.columns else [],
        "parts": focus[["ane_part_cd", "part_nm", "fld_cd"]].drop_duplicates().values.tolist()
        if "part_nm" in focus.columns else [],
        "accounts": df[["acnt_dv_cd", "acnt_dv_nm"]].drop_duplicates().values.tolist()
        if "acnt_dv_nm" in df.columns else [],
    }
    stats["focus_rows"] = len(focus)
    stats["names"] = names
    stats["regions"] = regions
    stats["missing_codes"] = dict(df.attrs.get("missing_codes", {}))

    # 집계 전후 금액이 맞는지 확인한다. 결측 키가 있으면 groupby 가 그 행을
    # 통째로 버려 예산이 조용히 사라진다. 코드에서 결측을 빈 문자열로
    # 못 박아 두었으므로 0이어야 하지만, 틀리면 반드시 드러나야 한다.
    stats["bdg_total"] = int(df["bdg_cash_amt"].sum())
    stats["bdg_grouped"] = int(tot["bdg"].sum())
    stats["bdg_dropped"] = stats["bdg_total"] - stats["bdg_grouped"]

    return tot, det, biz, stats


def code_sort_key(cd: str):
    """코드 정렬용. 빈 코드는 목록 맨 뒤로 보낸다 — 앞에 오면 눈에 걸린다."""
    c = str(cd).strip()
    return (1, "") if not c else (0, c)


def label(cd: str, nm) -> str:
    """코드가 비었거나 이름이 없는 항목의 표시 이름."""
    text = "" if nm is None else str(nm).strip()
    if text and text.lower() != "nan":
        return text
    return "(코드 없음)" if not str(cd).strip() else f"({cd})"


def region_type(name: str) -> str:
    """자치단체명에서 유형을 뽑는다. 비교군을 같은 유형으로 좁힐 때 쓴다."""
    n = str(name)
    if n.endswith("본청"):
        return "본청"
    for suffix, kind in (("특별자치시", "특별자치시"), ("특별자치도", "특별자치도"),
                         ("특별시", "특별시"), ("광역시", "광역시")):
        if n.endswith(suffix):
            return kind
    if n.endswith("시"):
        return "시"
    if n.endswith("군"):
        return "군"
    if n.endswith("구"):
        return "자치구"
    return "기타"


def col(df: pd.DataFrame, name: str, idx: dict | None = None) -> list:
    """컬럼 하나를 배열로. 사전이 주어지면 정수 색인으로 바꾼다."""
    s = df[name]
    if idx is None:
        return [int(v) for v in s]
    out = []
    for v in s.astype("string").fillna("").astype(object):
        key = str(v)
        if key not in idx:
            # 사전과 데이터가 어긋난 것이다. 조용히 넘기면 화면에서
            # 엉뚱한 항목으로 표시되므로 여기서 멈춘다.
            raise KeyError(f"{name}: 사전에 없는 코드 {key!r}")
        out.append(idx[key])
    return out


def write_json(path: Path, obj: object) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    path.write_text(blob, encoding="utf-8")
    return len(blob.encode("utf-8"))


def build_sido_file(sido_cd: str, tot: pd.DataFrame, det: pd.DataFrame,
                    regions: pd.DataFrame) -> dict:
    """
    시도 하나의 집계 파일을 만든다.

    행 객체 대신 컬럼별 배열로 저장한다. 같은 값이 길게 반복되는 구조라
    이 형태가 훨씬 작고, Pages 의 gzip 전송에서도 유리하다.
    """
    r_idx = {v: i for i, v in enumerate(uniq_str(regions["laf_cd"]))}
    fields = sorted(set(uniq_str(tot["fld_cd"])) | set(uniq_str(det["fld_cd"])))
    parts = uniq_str(det["ane_part_cd"])
    accts = sorted(set(uniq_str(tot["acnt_dv_cd"])) | set(uniq_str(det["acnt_dv_cd"])))
    f_idx = {v: i for i, v in enumerate(fields)}
    p_idx = {v: i for i, v in enumerate(parts)}
    a_idx = {v: i for i, v in enumerate(accts)}

    out = {
        "schema": "agg/1",
        "sido": sido_cd,
        "regions": uniq_str(regions["laf_cd"]),
        "fields": fields,
        "parts": parts,
        "accounts": accts,
        # 전 분야 총액 — 퍼센트 분모
        "tot": {
            "n": len(tot),
            "y": col(tot, "fyr"),
            "r": col(tot, "laf_cd", r_idx),
            "a": col(tot, "acnt_dv_cd", a_idx),
            "f": col(tot, "fld_cd", f_idx),
            "bdg": col(tot, "bdg"),
        },
        # 080·090 부문별
        "det": {
            "n": len(det),
            "y": col(det, "fyr"),
            "r": col(det, "laf_cd", r_idx),
            "a": col(det, "acnt_dv_cd", a_idx),
            "f": col(det, "fld_cd", f_idx),
            "p": col(det, "ane_part_cd", p_idx),
        },
    }
    for k in ("bdg", "ntep", "capep", "sggep", "etc", "exec", "nbiz", "nrow"):
        if k in det.columns:
            out["det"][k] = col(det, k)
    return out


def build_biz_file(region_cd: str, biz: pd.DataFrame) -> dict:
    """
    지자체 하나의 세부사업 파일을 만든다.

    같은 사업이 해마다 같은 이름으로 반복되므로, 이름을 사전으로 분리하고
    행에는 색인 정수만 둔다. 16자리 사업코드도 파일 안에서만 통하는
    작은 정수로 바꾼다. 검색도 빨라지는데, 수천 행 대신 수백 건짜리
    사전만 훑으면 되기 때문이다.

    공백 제거 사본은 저장하지 않는다. 사전이 작아서 브라우저가 읽을 때
    만드는 편이 낫고, 원본과 어긋날 여지도 없앤다.
    """
    names = uniq_str(biz["dbiz_nm"])
    codes = uniq_str(biz["dbiz_cd"])
    parts = uniq_str(biz["ane_part_cd"])
    accts = uniq_str(biz["acnt_dv_cd"])
    n_idx = {v: i for i, v in enumerate(names)}
    c_idx = {v: i for i, v in enumerate(codes)}
    p_idx = {v: i for i, v in enumerate(parts)}
    a_idx = {v: i for i, v in enumerate(accts)}

    out = {
        "schema": "biz/1",
        "region": region_cd,
        "names": names,
        "codes": codes,
        "parts": parts,
        "accounts": accts,
        "n": len(biz),
        "y": col(biz, "fyr"),
        "p": col(biz, "ane_part_cd", p_idx),
        "a": col(biz, "acnt_dv_cd", a_idx),
        "nm": col(biz, "dbiz_nm", n_idx),
        "bc": col(biz, "dbiz_cd", c_idx),
        "bdg": col(biz, "bdg_cash_amt"),
    }
    if "ep_amt" in biz.columns:
        out["exec"] = col(biz, "ep_amt")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="집계 및 사이트 생성")
    ap.add_argument("--years", type=int, nargs="+", default=None)
    ap.add_argument("--source-repo", default=None)
    ap.add_argument("--keep-cache", action="store_true",
                    help="원자료 CSV 를 지우지 않는다 (로컬 반복 실행용)")
    args = ap.parse_args()

    setup_logging()
    CACHE.mkdir(parents=True, exist_ok=True)
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir(parents=True)

    assets = list_source_assets(args.source_repo)
    ymap = year_asset_map(assets)
    targets = sorted(set(args.years) & set(ymap)) if args.years else sorted(ymap)
    if not targets:
        raise SourceRepoError("집계할 연도가 없습니다.")
    log.info("집계 대상: %s", ", ".join(str(y) for y in targets))

    progress = None
    try:
        progress = fetch_progress(args.source_repo)
    except SourceRepoError:
        raise
    except Exception as e:
        log.warning("progress.json 조회 실패: %s", e)

    tots, dets, bizs, regs = [], [], [], []
    year_stats: dict[int, dict] = {}
    names_acc = {"fields": {}, "parts": {}, "accounts": {}}
    region_years: dict[str, set] = {}

    # 연도별로 읽고 즉시 집계한다. 10년을 한꺼번에 올리면
    # 430만 행이 메모리에 쌓여 러너가 버티지 못한다.
    for year in targets:
        meta = ymap[year]
        log.info("=" * 60)
        log.info("%d년 (%s, %.1f MB)", year, meta["name"], meta["size"] / 1e6)
        path = download_asset(meta["id"], CACHE / meta["name"], args.source_repo, meta["size"])

        df = read_year_csv(path)
        tot, det, biz, stats = aggregate_year(df)

        tots.append(tot)
        dets.append(det)
        bizs.append(biz)
        regs.append(stats["regions"])

        for cd in stats["regions"]["laf_cd"].astype(str):
            region_years.setdefault(cd, set()).add(year)
        for k, pairs in stats["names"].items():
            for row in pairs:
                names_acc[k][str(row[0])] = row

        year_stats[year] = {
            "rows": stats["rows"],
            "focus_rows": stats["focus_rows"],
            "identity_mismatch": stats.get("identity_mismatch"),
            "identity_max_diff": stats.get("identity_max_diff"),
            "coerce_failed": stats.get("coerce_failed", 0),
            "incomplete_asset": meta["incomplete"],
            "missing_codes": stats.get("missing_codes", {}),
            "bdg_dropped": stats.get("bdg_dropped", 0),
        }
        if stats.get("bdg_dropped"):
            log.error("  ★ %d년 집계에서 예산 %d원이 사라졌습니다 — 결측 키 확인 필요",
                      year, stats["bdg_dropped"])
        if stats.get("missing_codes"):
            log.warning("  코드 결측: %s", stats["missing_codes"])
        log.info("  총 %d행 → 전분야집계 %d행 / 080·090 %d행 / 세부사업 %d행",
                 stats["rows"], len(tot), len(det), len(biz))

        del df, tot, det, biz, stats
        gc.collect()
        if not args.keep_cache:
            path.unlink(missing_ok=True)

    log.info("=" * 60)
    log.info("연도별 결과 결합")

    tot_all = pd.concat(tots, ignore_index=True); del tots
    det_all = pd.concat(dets, ignore_index=True); del dets
    biz_all = pd.concat(bizs, ignore_index=True); del bizs
    reg_all = pd.concat(regs, ignore_index=True).drop_duplicates("laf_cd")
    del regs
    gc.collect()

    reg_all["type"] = reg_all["laf_hg_nm"].map(region_type)
    reg_all = reg_all.sort_values("laf_cd").reset_index(drop=True)

    sido_col = "wa_laf_cd" if "wa_laf_cd" in reg_all.columns else None
    sido_nm_col = "wa_laf_hg_nm" if "wa_laf_hg_nm" in reg_all.columns else None
    if sido_col is None:
        # 광역 코드가 없으면 자치단체 코드 앞 두 자리를 시도로 쓴다.
        reg_all["_sido"] = reg_all["laf_cd"].astype(str).str[:2]
        reg_all["_sido_nm"] = reg_all["_sido"]
    else:
        reg_all["_sido"] = reg_all[sido_col].astype(str)
        reg_all["_sido_nm"] = (reg_all[sido_nm_col].astype(str)
                               if sido_nm_col else reg_all["_sido"])

    r2s = dict(zip(reg_all["laf_cd"].astype(str), reg_all["_sido"]))

    # ── 시도별 집계 파일
    data_dir = SITE / "data"
    agg_sizes, agg_files = {}, 0
    for sido_cd, group in reg_all.groupby("_sido"):
        codes = set(group["laf_cd"].astype(str))
        t = tot_all[tot_all["laf_cd"].astype(str).isin(codes)]
        d = det_all[det_all["laf_cd"].astype(str).isin(codes)]
        if t.empty and d.empty:
            continue
        payload = build_sido_file(sido_cd, t, d, group)
        size = write_json(data_dir / "agg" / f"{sido_cd}.json", payload)
        agg_sizes[sido_cd] = size
        agg_files += 1
    log.info("시도 집계 %d개 파일, 합계 %.1f MB", agg_files, sum(agg_sizes.values()) / 1e6)

    # ── 지자체별 세부사업 파일
    biz_sizes = {}
    for region_cd, group in biz_all.groupby(biz_all["laf_cd"].astype(str)):
        payload = build_biz_file(region_cd, group)
        biz_sizes[region_cd] = write_json(data_dir / "biz" / f"{region_cd}.json", payload)
    total_biz = sum(biz_sizes.values())
    log.info("세부사업 %d개 파일, 합계 %.1f MB (평균 %.0f KB)",
             len(biz_sizes), total_biz / 1e6,
             total_biz / max(len(biz_sizes), 1) / 1024)

    # ── 완전성 검산
    completeness = {}
    if progress:
        for y, info in progress.get("completed_years", {}).items():
            count = int(info.get("count", 0))
            total = int(info.get("total_count", 0)) or count
            completeness[int(y)] = {
                "count": count, "total": total,
                "rate": round(count / total, 6) if total else 0.0,
                "missing": max(total - count, 0),
            }

    # ── 매니페스트. 화면의 모든 선택지가 여기서 나온다.
    warnings: list[str] = []
    identity_total = sum(v.get("identity_mismatch") or 0 for v in year_stats.values())
    rows_total = sum(v["rows"] for v in year_stats.values())
    identity_rate = identity_total / rows_total if rows_total else 0.0
    if identity_rate > 0.01:
        warnings.append(
            f"재원 항등식 불일치율이 {identity_rate:.2%} 입니다. 재원 구성 수치는 신뢰할 수 없습니다.")
    elif identity_total:
        warnings.append(
            f"재원 항등식이 {identity_total:,}행({identity_rate:.4%})에서 어긋납니다.")
    for y, c in completeness.items():
        if c["missing"] and y in year_stats:
            warnings.append(f"{y}년 원자료가 {c['missing']:,}건 누락되었습니다 (수집률 {c['rate']:.2%}).")

    # 코드 결측 — 화면에 드러내야 한다. 부문 코드가 빈 행은 '(코드 없음)'
    # 항목으로 집계에 남으므로 값이 사라지지는 않지만, 그 사실은 알려야 한다.
    code_missing: dict[str, int] = {}
    for v in year_stats.values():
        for col_name, n in (v.get("missing_codes") or {}).items():
            code_missing[col_name] = code_missing.get(col_name, 0) + n
    if code_missing:
        detail = ", ".join(f"{k} {n:,}건" for k, n in sorted(code_missing.items()))
        warnings.append(f"코드가 비어 있는 행이 있습니다 ({detail}). '(코드 없음)' 으로 묶여 표시됩니다.")
    dropped = sum(v.get("bdg_dropped", 0) for v in year_stats.values())
    if dropped:
        warnings.append(f"★ 집계 과정에서 예산 {dropped:,}원이 누락되었습니다. 수치를 신뢰할 수 없습니다.")

    sido_list = [
        {"cd": cd, "nm": str(g["_sido_nm"].iloc[0]), "n_region": int((~g["head"]).sum())}
        for cd, g in reg_all.groupby("_sido")
    ]
    region_list = [
        {"cd": str(r["laf_cd"]), "nm": str(r["laf_hg_nm"]), "sido": str(r["_sido"]),
         "type": str(r["type"]), "head": bool(r["head"]),
         "years": sorted(region_years.get(str(r["laf_cd"]), []))}
        for _, r in reg_all.iterrows()
    ]

    # ── 지도 크로스워크. 경계 데이터와 코드 체계가 달라 이름으로 잇는다.
    log.info("지도 크로스워크")
    geo = build_geo.build(region_list, sido_list, data_dir / "geo")
    warnings.extend(geo["warnings"])

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "built_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST"),
        "source": {
            "api": "지방재정365 세부사업별 세출현황 (QWGJK)",
            "basis": "각 회계연도 12월 31일 기준",
            "note": "예산 기준 명칭(최종예산/예산현액)은 확인되지 않았습니다.",
        },
        "focus_fields": list(FOCUS_FIELDS),
        "years": [
            {
                "y": y,
                "rows": year_stats[y]["rows"],
                "focus_rows": year_stats[y]["focus_rows"],
                "completeness": completeness.get(y, {}).get("rate"),
                "missing": completeness.get(y, {}).get("missing"),
                "asset_incomplete": year_stats[y]["incomplete_asset"],
            }
            for y in targets
        ],
        "sido": sido_list,
        "regions": region_list,
        "geo": {
            "available": geo["available"],
            "match_rate": geo["crosswalk"]["match"]["rate"],
            "matched": geo["crosswalk"]["match"]["regions_matched"],
            "total": geo["crosswalk"]["match"]["regions_total"],
            "source": geo["crosswalk"]["source"],
        },
        # 코드가 비어 있는 항목에도 이름을 준다. 이름 없이 두면 화면에
        # 빈칸으로 나와 무엇인지 알 수 없다.
        "fields": [
            {"cd": cd, "nm": label(cd, row[1])}
            for cd, row in sorted(names_acc["fields"].items(), key=lambda kv: code_sort_key(kv[0]))
        ],
        "parts": [
            {"cd": cd, "nm": label(cd, row[1]), "fld": str(row[2])}
            for cd, row in sorted(names_acc["parts"].items(), key=lambda kv: code_sort_key(kv[0]))
        ],
        "accounts": [
            {"cd": cd, "nm": label(cd, row[1])}
            for cd, row in sorted(names_acc["accounts"].items(), key=lambda kv: code_sort_key(kv[0]))
        ],
        "files": {"agg": "data/agg/{sido}.json", "biz": "data/biz/{region}.json"},
        "sizes": {
            "agg_total_bytes": sum(agg_sizes.values()),
            "biz_total_bytes": total_biz,
            "biz_files": len(biz_sizes),
            "biz_avg_bytes": int(total_biz / max(len(biz_sizes), 1)),
            "biz_max_bytes": max(biz_sizes.values()) if biz_sizes else 0,
        },
        "validation": {
            "revenue_identity_mismatch_rows": identity_total,
            "revenue_identity_mismatch_rate": round(identity_rate, 6),
            "coerce_failed": sum(v["coerce_failed"] for v in year_stats.values()),
        },
        "warnings": warnings,
    }
    size = write_json(data_dir / "manifest.json", manifest)
    log.info("매니페스트 %.0f KB — 연도 %d / 시도 %d / 자치단체 %d / 부문 %d",
             size / 1024, len(manifest["years"]), len(manifest["sido"]),
             len(manifest["regions"]), len(manifest["parts"]))

    # ── 정적 파일 복사
    for item in WEB.iterdir():
        dest = SITE / item.name
        shutil.copytree(item, dest) if item.is_dir() else shutil.copy2(item, dest)

    total = sum(f.stat().st_size for f in SITE.rglob("*") if f.is_file())
    log.info("=" * 60)
    log.info("사이트 생성 완료: %.1f MB", total / 1e6)
    if total > 900e6:
        log.warning("Pages 사이트 한도(1GB)에 근접합니다.")
    for w in warnings:
        log.warning("경고: %s", w)
    return 0


if __name__ == "__main__":
    import sys
    try:
        raise SystemExit(main())
    except SourceRepoError as e:
        print(f"\n{'='*60}\n{e}\n{'='*60}\n", file=sys.stderr)
        raise SystemExit(2)
