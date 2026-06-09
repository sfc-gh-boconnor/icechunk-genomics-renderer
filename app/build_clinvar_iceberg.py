#!/usr/bin/env python3
"""
build_clinvar_iceberg.py — one-off local loader.

Parses the chr22 ClinVar VCF (via TBI byte-range, no full download) and writes
a CSV with disease (CLNDN) and gene (GENEINFO) added, for loading into the
CHR22_CLINVAR Iceberg table. Pure-Python (no numpy/zarr needed).

Output: /tmp/chr22_clinvar.csv  (header included)
"""
from __future__ import annotations
import csv, gzip, io, os, struct, sys, urllib.request

CLINVAR_VCF_URL = "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz"
CLINVAR_TBI_URL = CLINVAR_VCF_URL + ".tbi"
# Genome-wide: all autosomes + X. Override with CLINVAR_CHROMS env (comma list).
ALL_CHROMS = [f"chr{i}" for i in range(1, 23)] + ["chrX"]
CHROMS = os.environ.get("CLINVAR_CHROMS", ",".join(ALL_CHROMS)).split(",")
OUT = "/tmp/clinvar_all.csv"

_CLINSIG_MAP = {
    "benign": 0, "likely_benign": 1, "uncertain_significance": 2, "vus": 2,
    "likely_pathogenic": 3, "pathogenic": 4,
    "conflicting_interpretations_of_pathogenicity": 5,
    "conflicting_classifications_of_pathogenicity": 5,
    "conflicting_interpretations": 5,
}
_REVSTAT_MAP = {
    "no_assertion_provided": 0, "no_assertion_criteria_provided": 0,
    "no_classification_provided": 0,
    "criteria_provided,_single_submitter": 1,
    "criteria_provided,_conflicting_classifications": 1,
    "criteria_provided,_multiple_submitters,_no_conflicts": 2,
    "reviewed_by_expert_panel": 3, "practice_guideline": 4,
}
_SKIP_DISEASE = {"not_provided", "not_specified", "", "see_cases"}


def _encode_clinsig(raw: str) -> int:
    if not raw:
        return 6
    parts = [p.strip().lower().replace(" ", "_") for p in raw.split("|")]
    vals = [_CLINSIG_MAP.get(p, 6) for p in parts if p in _CLINSIG_MAP]
    return max(vals) if vals else 6


def _encode_revstat(raw: str) -> int:
    return _REVSTAT_MAP.get(raw.strip().lower(), 0) if raw else 0


def _clean_disease(raw: str) -> str:
    """CLNDN: 'Foo_bar|not_provided' -> 'Foo bar'. Pick first informative name."""
    if not raw:
        return ""
    for part in raw.split("|"):
        p = part.strip()
        if p.lower() not in _SKIP_DISEASE:
            return p.replace("_", " ")[:200]
    return ""


def _gene(raw: str) -> str:
    """GENEINFO: 'SHANK3:85358|...' -> 'SHANK3'."""
    if not raw:
        return ""
    return raw.split("|")[0].split(":")[0].strip()[:40]


def _http_range(url: str, start: int, end: int) -> bytes:
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def _tbi_chrom_range(tbi_bytes: bytes, chrom: str) -> tuple[int, int]:
    def _decompress(data: bytes) -> bytes:
        out, buf = [], io.BytesIO(data)
        while True:
            h = buf.read(18)
            if len(h) < 18 or h[:2] != b"\x1f\x8b":
                break
            bsize = struct.unpack("<H", h[16:18])[0] + 1
            rest = buf.read(bsize - 18)
            try:
                out.append(gzip.decompress(h + rest))
            except Exception:
                break
        return b"".join(out)

    raw = _decompress(tbi_bytes)
    buf = io.BytesIO(raw)
    if buf.read(4) != b"TBI\x01":
        raise ValueError("Not a TBI file")
    n_ref = struct.unpack("<i", buf.read(4))[0]
    buf.read(24)
    l_nm = struct.unpack("<i", buf.read(4))[0]
    names = [n.decode() for n in buf.read(l_nm).rstrip(b"\x00").split(b"\x00")]
    if chrom not in names:
        raise ValueError(f"{chrom!r} not in TBI. Available: {names[:5]}")
    chrom_idx = names.index(chrom)
    all_ioffs = []
    for _ in range(n_ref):
        n_bin = struct.unpack("<i", buf.read(4))[0]
        for _ in range(n_bin):
            buf.read(4)
            buf.read(struct.unpack("<i", buf.read(4))[0] * 16)
        n_intv = struct.unpack("<i", buf.read(4))[0]
        all_ioffs.append([struct.unpack("<Q", buf.read(8))[0] for _ in range(n_intv)])
    ti = all_ioffs[chrom_idx]
    start_vfo = next((x for x in ti if x > 0), None)
    if start_vfo is None:
        raise ValueError(f"No data for {chrom!r}")
    start = start_vfo >> 16
    nxt = chrom_idx + 1
    if nxt < len(all_ioffs) and any(x > 0 for x in all_ioffs[nxt]):
        end = (next(x for x in all_ioffs[nxt] if x > 0) >> 16) + 65536
    else:
        end = start + 50_000_000
    return start, end


def _decompress_bgzf_str(data: bytes) -> str:
    out, buf = [], io.BytesIO(data)
    while True:
        h = buf.read(18)
        if len(h) < 18 or h[:2] != b"\x1f\x8b":
            break
        bsize = struct.unpack("<H", h[16:18])[0] + 1
        rest = buf.read(bsize - 18)
        try:
            out.append(gzip.decompress(h + rest).decode("utf-8", errors="replace"))
        except Exception:
            break
    return "".join(out)


def _parse_chrom(text: str, tbi_chrom: str, out_chrom: str, w) -> int:
    rows = 0
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t", 9)
        if len(parts) < 8 or parts[0] != tbi_chrom:
            continue
        _, pos_str, _, ref, alt_str, _, _, info_str = parts[:8]
        try:
            pos = int(pos_str)
        except ValueError:
            continue
        info: dict = {}
        for kv in info_str.split(";"):
            if "=" in kv:
                k, v = kv.split("=", 1)
                info[k] = v
        alts = alt_str.split(",")
        aid = info.get("ALLELEID", "0")
        w.writerow([
            out_chrom, pos,
            _encode_clinsig(info.get("CLNSIG", "")),
            _encode_revstat(info.get("CLNREVSTAT", "")),
            int(aid) if aid.isdigit() else 0,
            min(len(ref), 127),
            min(len(alts[0]) if alts else 1, 127),
            _clean_disease(info.get("CLNDN", "")),
            _gene(info.get("GENEINFO", "")),
        ])
        rows += 1
    return rows


def main() -> None:
    print("Fetching TBI index…", file=sys.stderr)
    tbi = urllib.request.urlopen(CLINVAR_TBI_URL, timeout=180).read()
    total = 0
    with open(OUT, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["CHROM", "POSITION", "CLINSIG", "REVSTAT", "ALLELE_ID",
                    "REF_LEN", "ALT_LEN", "DISEASE", "GENE"])
        for chrom in CHROMS:
            tbi_chrom = chrom.removeprefix("chr")
            try:
                start, end = _tbi_chrom_range(tbi, tbi_chrom)
            except Exception as e:
                print(f"{chrom}: skip ({e})", file=sys.stderr)
                continue
            vcf = _http_range(CLINVAR_VCF_URL, start, end)
            text = _decompress_bgzf_str(vcf)
            n = _parse_chrom(text, tbi_chrom, chrom, w)
            total += n
            print(f"{chrom}: {n:,} rows ({(end-start)//1024:,} KB)", file=sys.stderr)
    print(f"Wrote {total:,} total rows to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
