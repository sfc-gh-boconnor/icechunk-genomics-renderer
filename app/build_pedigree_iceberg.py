#!/usr/bin/env python3
"""
build_pedigree_iceberg.py — 1000 Genomes 3,202-sample trio pedigree → CSV.

Source: EBI 1kGP.3202_samples.pedigree_info.txt (cols: sampleID fatherID motherID sex).
'0' means unknown parent. Writes /tmp/pedigree.csv for COPY INTO SAMPLE_PEDIGREE.
Re-runnable.
"""
import csv
import urllib.request

URL = ("https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/"
       "1000G_2504_high_coverage/working/1kGP.3202_samples.pedigree_info.txt")
OUT = "/tmp/pedigree.csv"


def run() -> int:
    req = urllib.request.Request(URL, headers={"User-Agent": "gragen/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        lines = r.read().decode("utf-8").splitlines()

    rows = []
    for line in lines[1:]:  # skip header
        parts = line.split()
        if len(parts) < 4:
            continue
        sid, fid, mid, sex = parts[0], parts[1], parts[2], parts[3]
        father = "" if fid == "0" else fid
        mother = "" if mid == "0" else mid
        relationship = "child" if (father or mother) else "founder"
        sex_label = "male" if sex == "1" else "female" if sex == "2" else ""
        rows.append([sid, father, mother, sex_label, relationship])

    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["SAMPLE_ID", "FATHER_ID", "MOTHER_ID", "SEX", "RELATIONSHIP"])
        w.writerows(rows)

    n_children = sum(1 for r in rows if r[4] == "child")
    print(f"Wrote {len(rows)} pedigree rows to {OUT} ({n_children} children with >=1 parent)")
    return len(rows)


if __name__ == "__main__":
    run()
