
"""
fit_calibration.py  (V2 with per-group beta)
------------------------------------------------
Offline calibration fitter for emotion probabilities.

- Reads facedist CSV (from export_facedist.js): columns path,y_true,gender,face_found,p_neutral,...,p_surprised
- Fits temperature scaling (global and optionally by group, e.g., gender) to minimize NLL.
- Derives logit bias (beta) both globally and per-group (if --group given and enough samples).
- Merges results into an existing calibration-temp.json if provided, preserving bias_mult.
- Writes updated calibration-temp.json that your server (hot-reload) can consume.

Usage:
  python fit_calibration.py --csv out/facedist.csv --out calibration-temp.json \
      --group gender --_in calibration-temp.json

Dependencies:
  pip install numpy pandas
"""
import argparse, json, os
import numpy as np
import pandas as pd

EMOS = ["neutral","happy","sad","angry","fearful","disgusted","surprised"]

def logit(p):
    p = np.clip(p, 1e-8, 1-1e-8)
    return np.log(p/(1-p))

def softmax(z):
    z = np.array(z, dtype=float)
    z = z - np.max(z, axis=1, keepdims=True)
    ez = np.exp(z)
    return ez / np.clip(ez.sum(axis=1, keepdims=True), 1e-12, None)

def nll_loss(logits, y_true_idx):
    p = softmax(logits)
    idx = (np.arange(len(y_true_idx)), y_true_idx)
    ll = np.log(np.clip(p[idx], 1e-12, None))
    return -ll.mean()

def fit_scalar_temperature(logits, y_idx):
    # coarse-to-fine search for tau \in [0.7, 1.3]
    taus = np.linspace(0.7, 1.3, 25)
    best_tau, best_nll = 1.0, 1e18
    for t in taus:
        nll = nll_loss(logits / t, y_idx)
        if nll < best_nll:
            best_tau, best_nll = t, nll
    # local refine
    step = 0.02
    for _ in range(40):
        cand = np.array([best_tau-step, best_tau, best_tau+step])
        nlls = [nll_loss(logits / c, y_idx) for c in cand]
        best_tau = float(cand[int(np.argmin(nlls))])
        best_tau = float(np.clip(best_tau, 0.5, 2.0))
        step *= 0.7
        if step < 5e-4: break
    return float(best_tau), float(best_nll)

def compute_logits_from_probs(P):
    P = np.clip(P, 1e-8, 1-1e-8)
    return logit(P)

def labels_to_idx(labels):
    mapping = {e:i for i,e in enumerate(EMOS)}
    return np.array([mapping.get(y, -1) for y in labels], dtype=int)

def logit_bias_from_margins(P, labels):
    """Global per-class logit bias: beta_e = logit(freq_true_e) - logit(mean_pred_e)."""
    C = P.shape[1]
    freq_true = np.array([(labels == e).mean() for e in EMOS])
    mean_pred = P.mean(axis=0)
    beta = logit(np.clip(freq_true, 1e-6, 1-1e-6)) - logit(np.clip(mean_pred, 1e-6, 1-1e-6))
    return beta

def logit_bias_per_group(df, group_col):
    out = {}
    for g in sorted(df[group_col].fillna('unknown').unique()):
        sub = df[df[group_col].fillna('unknown') == g]
        if len(sub) < 50:
            continue  # too few samples; skip
        P = sub[[f"p_{e}" for e in EMOS]].values.astype(float)
        beta = logit_bias_from_margins(P, sub['y_true'].values)
        out[str(g)] = {EMOS[i]: float(np.round(beta[i], 3)) for i in range(len(EMOS))}
    return out

def quick_ece(probs, y_idx, bins=10):
    conf = probs.max(1)
    preds = probs.argmax(1)
    edges = np.linspace(0,1,bins+1)
    e = 0.0; n = len(y_idx)
    for i in range(bins):
        m = (conf >= edges[i]) & (conf < edges[i+1])
        if m.sum() == 0: continue
        acc = (preds[m] == y_idx[m]).mean()
        c = conf[m].mean()
        e += (m.sum()/n) * abs(acc - c)
    return float(e)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--group', default=None, help='e.g., gender (fits per-group tau & beta if enough samples)')
    ap.add_argument('--_in', dest='in_path', default=None, help='existing calibration json to merge')
    args = ap.parse_args()

    df = pd.read_csv(args.csv)
    # keep only valid rows
    df = df[(df['face_found'] == 1) & (df['y_true'].isin(EMOS))].copy()
    if len(df) < 50:
        print(f"[WARN] Only {len(df)} valid rows; results may be noisy.")
    P = df[[f"p_{e}" for e in EMOS]].values.astype(float)
    y_idx = labels_to_idx(df['y_true'].values)
    L = compute_logits_from_probs(P)

    # global tau
    tau_global, nll_global = fit_scalar_temperature(L, y_idx)
    print(f"[CAL] global tau={tau_global:.3f} | NLL={nll_global:.4f}")

    # per-group tau
    tau_groups = {}
    if args.group and args.group in df.columns:
        for g in sorted(df[args.group].fillna('unknown').unique()):
            sub = df[df[group_col:=args.group].fillna('unknown') == g]
            if len(sub) >= 50:
                Lg = compute_logits_from_probs(sub[[f"p_{e}" for e in EMOS]].values.astype(float))
                yg = labels_to_idx(sub['y_true'].values)
                tau_g, nll_g = fit_scalar_temperature(Lg, yg)
                tau_groups[str(g)] = float(tau_g)
                print(f"[CAL] {args.group}={g}: tau={tau_g:.3f} | NLL={nll_g:.4f}")
            else:
                print(f"[CAL] {args.group}={g}: too few samples ({len(sub)}), skip tau")

    # beta: global + per-group (if available)
    beta_global = logit_bias_from_margins(P, df['y_true'].values)
    beta_global = {EMOS[i]: float(np.round(beta_global[i], 3)) for i in range(len(EMOS))}
    print("[CAL] beta(global):", beta_global)

    beta_groups = {}
    if args.group and args.group in df.columns:
        beta_groups = logit_bias_per_group(df, args.group)
        for g, b in beta_groups.items():
            print(f"[CAL] beta({args.group}={g}): {b}")

    # Merge into existing calibration
    calib = {}
    if args.in_path and os.path.exists(args.in_path):
        try:
            with open(args.in_path, 'r', encoding='utf-8') as f:
                calib = json.load(f)
        except Exception as e:
            print("[WARN] Failed to parse existing calibration, starting fresh:", e)
            calib = {}

    # Temperature table: keep backward-compat (keys 'default', 'none:<group>')
    def tau_vec(tau): return {e: float(tau) for e in EMOS}
    calib['default'] = tau_vec(tau_global)
    if tau_groups:
        for g, t in tau_groups.items():
            calib[f"none:{g}"] = tau_vec(t)

    # bias_add: write global and per-group (if any)
    bias_add = calib.get('bias_add', {})
    bias_add['global'] = beta_global
    for g, b in beta_groups.items():
        bias_add[str(g)] = b
    calib['bias_add'] = bias_add

    # preserve bias_mult if present; otherwise leave untouched
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(calib, f, ensure_ascii=False, indent=2)
    print(f"[CAL] Wrote {args.out}")

    # quick metrics
    # raw acc/ECE vs global-calibrated acc/ECE
    def apply_tau(P, tau):
        L = logit(np.clip(P, 1e-8, 1-1e-8))
        Sc = softmax(L / tau)
        return Sc
    S_raw = P
    S_cal = apply_tau(P, tau_global)
    acc_raw = (S_raw.argmax(1) == y_idx).mean()
    acc_cal = (S_cal.argmax(1) == y_idx).mean()
    print(f"[CAL] Top-1 acc raw={acc_raw:.3f} | cal={acc_cal:.3f}")
    print(f"[CAL] ECE raw={quick_ece(S_raw,y_idx):.3f} | cal={quick_ece(S_cal,y_idx):.3f}")

if __name__ == "__main__":
    main()
