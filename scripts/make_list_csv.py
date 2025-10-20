#!/usr/bin/env python3
# scripts/make_list_csv.py

"""
Auto-generate data/list.csv by scanning a dataset folder.

Folder layout options:
- Option A (recommended):
  root/
    happy/*.jpg
    sad/*.png
    ... (one subfolder per emotion name)

- Option B:
  any nested tree; this script will look for the emotion name
  in the immediate parent folder name or any ancestor path.

Usage:
  python scripts/make_list_csv.py --root path/to/dataset --out data/list.csv

Optional:
  --infer-gender   # naive: if path contains "/male/" -> male, "/female/" -> female, else unknown

Allowed labels: neutral,happy,sad,angry,fearful,disgusted,surprised
"""
import argparse, os, csv, sys

EMOS = {"neutral","happy","sad","angry","fearful","disgusted","surprised"}
IMG_EXT = {".jpg",".jpeg",".png",".bmp",".webp"}

def infer_emotion_from_path(p):
    parts = [x.lower() for x in p.replace("\\","/").split("/") if x]
    for x in parts[::-1]:  # check parent first
        if x in EMOS:
            return x
    return None

def infer_gender_from_path(p):
    s = p.replace("\\","/").lower()
    if "/male/" in s: return "male"
    if "/female/" in s: return "female"
    return "unknown"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", default="data/list.csv")
    ap.add_argument("--infer-gender", action="store_true")
    args = ap.parse_args()

    root = args.root
    rows = []
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in IMG_EXT: continue
            full = os.path.abspath(os.path.join(dirpath, fn))
            emo = infer_emotion_from_path(full)
            if emo is None:
                continue  # skip files without an emotion in their folder path
            gender = infer_gender_from_path(full) if args.infer_gender else "unknown"
            rows.append((full, emo, gender))

    if not rows:
        print("[ERR] No images found with emotion folder names under", root)
        sys.exit(1)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["path","label","gender"])
        w.writerows(rows)
    print(f"[OK] Wrote {args.out} with {len(rows)} rows.")

if __name__ == "__main__":
    main()
