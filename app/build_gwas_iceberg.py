#!/usr/bin/env python3
"""
build_gwas_iceberg.py — one-off local loader for chr22 GWAS Catalog hits.

Pulls associations for a set of EFO traits from the EBI GWAS Catalog REST API,
keeps chr22 hits (position embedded in the association JSON), and writes a CSV
for loading into the CHR22_GWAS Iceberg table.

Output: /tmp/chr22_gwas.csv
"""
from __future__ import annotations
import csv, json, sys, urllib.request

# (EFO id, human label) — neuro/psychiatric + a couple general traits with chr22 signal
TRAITS = [
    ("MONDO_0005090", "Schizophrenia"),
    ("MONDO_0005260", "Autism spectrum disorder"),
    ("MONDO_0004975", "Alzheimer disease"),
    ("EFO_0004611",   "LDL cholesterol"),
    ("EFO_0004340",   "Body mass index"),
]
OUT = "/tmp/gwas_all.csv"
_VALID_CHROMS = {str(i) for i in range(1, 23)} | {"X", "Y"}


def fetch(efo: str):
    url = (f"https://www.ebi.ac.uk/gwas/rest/api/efoTraits/{efo}/associations"
           f"?projection=associationByEfoTrait&size=2000")
    try:
        return json.load(urllib.request.urlopen(url, timeout=120))
    except Exception as e:
        print(f"  {efo}: ERR {e}", file=sys.stderr)
        return {}


def main() -> None:
    seen = set()
    rows = []
    for efo, label in TRAITS:
        d = fetch(efo)
        assoc = d.get("_embedded", {}).get("associations", [])
        kept = 0
        for a in assoc:
            pv = a.get("pvalue")
            risk = ""
            for loc in a.get("loci", []):
                for rr in loc.get("strongestRiskAlleles", []):
                    risk = rr.get("riskAlleleName", "") or risk
            for s in a.get("snps", []):
                rsid = s.get("rsId", "")
                genes = [gc.get("gene", {}).get("geneName")
                         for gc in s.get("genomicContexts", [])
                         if gc.get("isClosestGene") and gc.get("gene")]
                gene = (genes[0] if genes else "")
                for l in (s.get("locations") or []):
                    ch = str(l.get("chromosomeName"))
                    if ch not in _VALID_CHROMS:
                        continue
                    pos = l.get("chromosomePosition")
                    if pos is None:
                        continue
                    key = (ch, int(pos), label, rsid)
                    if key in seen:
                        continue
                    seen.add(key)
                    rows.append([
                        f"chr{ch}", int(pos), label, gene or "", rsid,
                        risk, float(pv) if pv is not None else None,
                    ])
                    kept += 1
        print(f"  {efo} ({label}): {kept} rows", file=sys.stderr)

    rows.sort(key=lambda r: (r[0], r[1]))
    with open(OUT, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["CHROM", "POSITION", "TRAIT", "MAPPED_GENE", "RSID",
                    "RISK_ALLELE", "P_VALUE"])
        w.writerows(rows)
    print(f"Wrote {len(rows)} GWAS rows to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
