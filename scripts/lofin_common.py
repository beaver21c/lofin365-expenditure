#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
공통 모듈 — 원자료 저장소(비공개) 접근과 CSV 로딩.

원자료는 이 저장소가 아니라 별도 비공개 저장소의 Releases에 있다.
연도별 CSV가 87~129MB라 GitHub의 파일당 100MB 제한을 넘기 때문에
git 저장소에는 넣을 수 없고, Releases가 유일하게 가능한 위치다.

접근은 pull 방향이다 — 공개 저장소의 워크플로가 비공개 저장소를 읽는다.
필요한 것은 대상 저장소 하나에만 Contents:Read 권한을 준
fine-grained PAT 하나이며, 워크플로 Secrets에 SOURCE_REPO_TOKEN으로 넣는다.
"""

from __future__ import annotations

import io
import os
import sys
import json
import time
import logging
from pathlib import Path
from typing import Iterable

import requests

# ─────────────────────────────────────────────────────────────
# 설정
# ─────────────────────────────────────────────────────────────

DEFAULT_SOURCE_REPO = "beaver21c/lofin365-expenditure-collector"
API_ROOT = "https://api.github.com"

# 이 대시보드가 분석 대상으로 삼는 분야. 사회복지 / 보건.
FOCUS_FIELDS = ("080", "090")

# 코드성 컬럼 — 반드시 문자열로 읽는다.
# fld_cd 는 "080" 처럼 앞자리 0이 있어 숫자로 바꾸면 비교가 전부 실패하고,
# dbiz_cd 는 16자리라 숫자로 읽으면 지수 표기로 손상된다.
CODE_COLS = (
    "fyr", "wa_laf_cd", "laf_cd", "acnt_dv_cd", "fld_cd",
    "ane_part_cd", "dept_cd", "dbiz_cd", "padm_laf_cd", "zon_cd",
    "exe_ymd", "lup_ord",
)

# 금액 컬럼 — 반드시 정수로 변환한다.
# 코드 컬럼과 같은 규칙(dtype=str)을 여기에 적용하면
# 합계가 문자열 이어붙이기가 되어 조용히 틀린다.
AMOUNT_COLS = (
    "bdg_cash_amt", "bdg_ntep", "capep", "sggep", "etc_amt", "ep_amt",
)

NAME_COLS = (
    "wa_laf_hg_nm", "laf_hg_nm", "acnt_dv_nm", "fld_nm", "part_nm", "dbiz_nm",
)

# 집계에 실제로 쓰는 컬럼만 읽는다. 26개 중 이만큼만 읽어도 충분하고
# 메모리 사용이 절반 이하로 떨어진다. cpl_amt 는 의미가 확인되지 않아
# 어느 지표에도 쓰지 않으므로 읽지 않는다.
USE_COLS = (
    "fyr", "wa_laf_cd", "wa_laf_hg_nm", "laf_cd", "laf_hg_nm",
    "acnt_dv_cd", "acnt_dv_nm", "fld_cd", "fld_nm",
    "ane_part_cd", "part_nm", "dbiz_cd", "dbiz_nm", "padm_laf_cd", "zon_cd",
    "bdg_cash_amt", "bdg_ntep", "capep", "sggep", "etc_amt", "ep_amt",
)

# 이 컬럼들이 없으면 집계 자체가 불가능하다.
REQUIRED_COLS = (
    "fyr", "laf_cd", "laf_hg_nm", "fld_cd", "ane_part_cd",
    "dbiz_cd", "dbiz_nm", "acnt_dv_cd", "bdg_cash_amt",
)

log = logging.getLogger("lofin")


def setup_logging(verbose: bool = True) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )


# ─────────────────────────────────────────────────────────────
# 원자료 저장소 접근
# ─────────────────────────────────────────────────────────────

class SourceRepoError(RuntimeError):
    """원자료 저장소에 접근할 수 없을 때. 메시지에 해결 방법을 담는다."""


def get_token() -> str:
    """
    비공개 저장소 읽기 토큰을 가져온다.

    기본 GITHUB_TOKEN 은 자기 저장소 밖으로 나가지 못하므로 쓸 수 없다.
    없을 때 조용히 넘어가면 나중에 알 수 없는 404 로 실패하므로
    여기서 즉시, 해결 방법과 함께 멈춘다.
    """
    token = os.environ.get("SOURCE_REPO_TOKEN", "").strip()
    if token:
        return token
    raise SourceRepoError(
        "SOURCE_REPO_TOKEN 이 설정되지 않았습니다.\n"
        "\n"
        "원자료는 비공개 저장소의 Releases 에 있고, 기본 GITHUB_TOKEN 으로는\n"
        "다른 저장소를 읽을 수 없습니다. 아래 절차로 토큰을 만들어 주십시오.\n"
        "\n"
        "  1. github.com → Settings → Developer settings\n"
        "     → Personal access tokens → Fine-grained tokens → Generate new token\n"
        "  2. Repository access: Only select repositories → 원자료 저장소 하나만 선택\n"
        "  3. Permissions → Repository permissions → Contents: Read-only\n"
        "     (다른 권한은 주지 않습니다. 이 토큰이 새어 나가도 피해가 이것뿐이도록)\n"
        "  4. 이 저장소 → Settings → Secrets and variables → Actions\n"
        "     → New repository secret → 이름 SOURCE_REPO_TOKEN\n"
        "\n"
        "자세한 내용은 docs/SETUP.md 를 참고하십시오."
    )


def _api(session: requests.Session, token: str, path: str) -> object:
    r = session.get(
        f"{API_ROOT}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=60,
    )
    if r.status_code == 404:
        raise SourceRepoError(
            f"저장소를 찾을 수 없습니다: {path}\n"
            "비공개 저장소에 대한 권한이 없는 토큰도 404 로 응답합니다.\n"
            "토큰의 Repository access 에 해당 저장소가 포함되어 있는지,\n"
            "Contents: Read 권한이 있는지 확인해 주십시오."
        )
    if r.status_code in (401, 403):
        raise SourceRepoError(
            f"인증이 거부되었습니다 (HTTP {r.status_code}).\n"
            "토큰이 만료되었을 수 있습니다. fine-grained PAT 은 최대 1년이며\n"
            "만료 후에는 갱신이 필요합니다."
        )
    r.raise_for_status()
    return r.json()


def list_source_assets(source_repo: str | None = None) -> dict[str, dict]:
    """
    원자료 저장소의 모든 릴리스를 훑어 자산 목록을 만든다.

    수집은 연도를 나눠 여러 번 실행되었기 때문에 연도별 CSV 가
    여러 릴리스에 흩어져 있다. 같은 파일이 여러 릴리스에 있으면
    가장 최근 릴리스의 것을 쓴다.

    반환: {파일명: {id, size, tag, published_at}}
    """
    repo = source_repo or os.environ.get("SOURCE_REPO", DEFAULT_SOURCE_REPO)
    token = get_token()
    session = requests.Session()

    assets: dict[str, dict] = {}
    page = 1
    while True:
        releases = _api(session, token, f"/repos/{repo}/releases?per_page=100&page={page}")
        if not releases:
            break
        for rel in releases:
            for a in rel.get("assets", []):
                name = a["name"]
                prev = assets.get(name)
                # 릴리스 목록은 최신순이므로 먼저 본 것이 더 최신이다.
                if prev is None:
                    assets[name] = {
                        "id": a["id"],
                        "size": a["size"],
                        "tag": rel["tag_name"],
                        "published_at": rel.get("published_at"),
                    }
        page += 1
        if page > 20:  # 안전장치
            break

    if not assets:
        raise SourceRepoError(
            f"{repo} 에서 릴리스 자산을 찾지 못했습니다.\n"
            "수집 워크플로가 아직 실행되지 않았거나, 토큰 권한이 부족합니다."
        )
    log.info("원자료 저장소 %s: 자산 %d개", repo, len(assets))
    return assets


def download_asset(asset_id: int, dest: Path, source_repo: str | None = None,
                   expected_size: int | None = None) -> Path:
    """릴리스 자산 하나를 내려받는다. 이미 받아 둔 것이 크기까지 맞으면 건너뛴다."""
    repo = source_repo or os.environ.get("SOURCE_REPO", DEFAULT_SOURCE_REPO)
    token = get_token()

    if dest.exists() and expected_size and dest.stat().st_size == expected_size:
        log.info("  캐시 사용: %s (%.1f MB)", dest.name, dest.stat().st_size / 1e6)
        return dest

    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"{API_ROOT}/repos/{repo}/releases/assets/{asset_id}"
    t0 = time.time()
    with requests.get(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/octet-stream",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        stream=True,
        timeout=(30, 600),
    ) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(dest.suffix + ".part")
        got = 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
                got += len(chunk)
        tmp.replace(dest)

    # 부분 다운로드를 정상으로 착각하면 그 뒤 집계가 조용히 틀린다.
    if expected_size and got != expected_size:
        dest.unlink(missing_ok=True)
        raise SourceRepoError(
            f"{dest.name} 다운로드가 불완전합니다: {got:,} / {expected_size:,} 바이트"
        )
    log.info("  받음: %s (%.1f MB, %.1f초)", dest.name, got / 1e6, time.time() - t0)
    return dest


def fetch_progress(source_repo: str | None = None) -> dict | None:
    """
    수집 저장소의 progress.json 을 가져온다.

    연도별 수집 건수와 전체 건수가 들어 있어, 수집기가 '완전'으로 판정한
    연도가 정말 100% 였는지 여기서 검산할 수 있다. 수집기의 완전성 임계값이
    0.99 라서 최대 1%까지는 누락된 채로 완전으로 기록될 수 있다.
    """
    try:
        assets = list_source_assets(source_repo)
    except SourceRepoError:
        raise
    meta = assets.get("progress.json")
    if not meta:
        log.warning("progress.json 을 찾지 못했습니다 — 연도별 완전성 검산을 건너뜁니다")
        return None
    dest = Path(".cache") / "progress.json"
    download_asset(meta["id"], dest, source_repo, meta["size"])
    return json.loads(dest.read_text(encoding="utf-8"))


def year_asset_map(assets: dict[str, dict]) -> dict[int, dict]:
    """
    자산 목록에서 연도별 원자료 CSV 를 골라낸다.

    수집기는 완전 수집분을 lofin365_{연도}.csv,
    불완전분을 lofin365_{연도}_incomplete.csv 로 저장한다.
    완전분이 있으면 그쪽을 쓰고, 없을 때만 불완전분을 쓰되 표시를 남긴다.
    """
    out: dict[int, dict] = {}
    for name, meta in assets.items():
        if not name.startswith("lofin365_") or not name.endswith(".csv"):
            continue
        stem = name[len("lofin365_"):-len(".csv")]
        incomplete = stem.endswith("_incomplete")
        if incomplete:
            stem = stem[:-len("_incomplete")]
        if not stem.isdigit():
            continue
        year = int(stem)
        entry = {**meta, "name": name, "incomplete": incomplete}
        prev = out.get(year)
        if prev is None or (prev["incomplete"] and not incomplete):
            out[year] = entry
    return dict(sorted(out.items()))


# ─────────────────────────────────────────────────────────────
# CSV 로딩
# ─────────────────────────────────────────────────────────────

def read_year_csv(path: Path, usecols: Iterable[str] | None = None):
    """
    연도별 원자료 CSV 를 읽는다.

    코드 컬럼은 문자열로 고정하고 금액 컬럼은 정수로 변환한다.
    수집기가 utf-8-sig 로 저장하므로 인코딩을 맞춘다.
    실제 컬럼 구성이 확인되지 않았으므로(참고 문서 기준 26종 + 부가 4종)
    없는 컬럼을 요구하지 않고, 있는 것만 골라 읽는다.
    """
    import pandas as pd

    header = pd.read_csv(path, nrows=0, encoding="utf-8-sig")
    present = list(header.columns)

    missing = [c for c in REQUIRED_COLS if c not in present]
    if missing:
        raise ValueError(
            f"{path.name}: 집계에 필요한 컬럼이 없습니다: {missing}\n"
            f"실제 컬럼: {present}"
        )

    want = [c for c in (usecols or USE_COLS) if c in present]
    dtypes = {c: str for c in CODE_COLS if c in want}

    df = pd.read_csv(
        path,
        usecols=want,
        dtype=dtypes,
        encoding="utf-8-sig",
        low_memory=False,
    )

    # 금액은 반드시 숫자로. 빈 값·문자열 섞임을 방어하되,
    # 변환 실패 건수는 세어서 호출부가 보고할 수 있게 남긴다.
    coerce_failed = 0
    for c in AMOUNT_COLS:
        if c not in df.columns:
            continue
        raw = df[c]
        num = pd.to_numeric(raw, errors="coerce")
        coerce_failed += int(num.isna().sum() - raw.isna().sum())
        df[c] = num.fillna(0).astype("int64")

    # 코드 컬럼의 앞자리 0 보존. pandas 가 문자열로 읽어도
    # 원본에 공백이 섞이면 비교가 어긋나므로 정리한다.
    for c in CODE_COLS:
        if c in df.columns:
            df[c] = df[c].astype(str).str.strip()

    df.attrs["coerce_failed"] = coerce_failed
    df.attrs["columns_present"] = present
    return df


def field_of_part(part_cd: str) -> str:
    """
    부문 코드에서 상위 분야 코드를 얻는다.

    부문 코드는 분야 코드의 앞 두 자리를 공유한다(081 → 08x → 080).
    다만 이는 관측된 패턴이므로, 집계 단계에서 원자료의
    fld_cd 와 대조해 어긋나는 건이 있으면 보고한다.
    """
    return (part_cd or "")[:2] + "0"
