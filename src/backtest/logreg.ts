// Minimal logistic regression via IRLS (iteratively reweighted least squares)
// with L2 regularization. Designed for small problems (≤20 features, ~few hundred
// samples). No external dependencies.

export interface LogRegModel {
  weights: number[]; // length = nFeatures + 1; last entry is bias
  means: number[];   // per-feature mean used for z-score
  stds: number[];    // per-feature std used for z-score
  iterations: number;
  finalLogLikelihood: number;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function standardize(X: number[][]): { Z: number[][]; means: number[]; stds: number[] } {
  const n = X.length;
  const d = X[0].length;
  const means = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) means[j] += row[j];
  for (let j = 0; j < d; j++) means[j] /= n;

  const stds = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) stds[j] += (row[j] - means[j]) ** 2;
  for (let j = 0; j < d; j++) {
    stds[j] = Math.sqrt(stds[j] / n);
    if (stds[j] < 1e-8) stds[j] = 1; // avoid division by zero on constant features
  }

  const Z = X.map((row) => row.map((v, j) => (v - means[j]) / stds[j]));
  return { Z, means, stds };
}

function withBias(X: number[][]): number[][] {
  return X.map((row) => [...row, 1.0]);
}

// Solve (A + λI) x = b via Gauss-Jordan elimination. A is dxd, b is d.
function solveLinear(A: number[][], b: number[], lambda: number): number[] {
  const d = A.length;
  // augmented [A + λI | b]
  const M: number[][] = A.map((row, i) => [...row.map((v, j) => v + (i === j ? lambda : 0)), b[i]]);

  for (let col = 0; col < d; col++) {
    // pivot: find row with largest abs value in this column
    let pivot = col;
    for (let r = col + 1; r < d; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      // singular even after regularization — fall back to identity step
      throw new Error("singular matrix in IRLS solve");
    }
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    // normalize pivot row
    const piv = M[col][col];
    for (let j = col; j <= d; j++) M[col][j] /= piv;
    // eliminate other rows
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = col; j <= d; j++) M[r][j] -= factor * M[col][j];
    }
  }
  return M.map((row) => row[d]);
}

export function fitLogReg(
  X: number[][],
  y: number[],
  opts: { l2?: number; maxIter?: number; tol?: number } = {}
): LogRegModel {
  if (X.length !== y.length) throw new Error("X/y length mismatch");
  if (X.length === 0) throw new Error("empty training set");

  const l2 = opts.l2 ?? 1.0;
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tol ?? 1e-6;

  const { Z, means, stds } = standardize(X);
  const Xb = withBias(Z); // N × (d+1), bias is the last column (already standardized to 1)
  const N = Xb.length;
  const D = Xb[0].length;

  let w = new Array(D).fill(0);
  let prevLL = -Infinity;
  let iter = 0;

  for (iter = 0; iter < maxIter; iter++) {
    // p_i = sigmoid(x_i · w)
    const p = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      let z = 0;
      for (let j = 0; j < D; j++) z += Xb[i][j] * w[j];
      p[i] = sigmoid(z);
    }

    // Hessian: H = X^T W X  (W diagonal, W_ii = p_i (1 - p_i))
    const H: number[][] = Array.from({ length: D }, () => new Array(D).fill(0));
    for (let i = 0; i < N; i++) {
      const wi = p[i] * (1 - p[i]);
      if (wi < 1e-12) continue;
      for (let j = 0; j < D; j++) {
        const xij = Xb[i][j];
        for (let k = j; k < D; k++) {
          H[j][k] += wi * xij * Xb[i][k];
        }
      }
    }
    // Symmetrize
    for (let j = 0; j < D; j++) for (let k = 0; k < j; k++) H[j][k] = H[k][j];

    // Gradient: g = X^T (y - p)  (we want to maximize LL, so step in +g direction)
    const g = new Array(D).fill(0);
    for (let i = 0; i < N; i++) {
      const r = y[i] - p[i];
      for (let j = 0; j < D; j++) g[j] += Xb[i][j] * r;
    }
    // L2 penalty subtracts λ w from gradient (and adds λI to H)
    for (let j = 0; j < D - 1; j++) g[j] -= l2 * w[j]; // don't regularize bias

    let step: number[];
    try {
      step = solveLinear(H, g, l2);
    } catch {
      // singular — bail out with current weights
      break;
    }
    for (let j = 0; j < D; j++) w[j] += step[j];

    // Log-likelihood for convergence check
    let ll = 0;
    for (let i = 0; i < N; i++) {
      let z = 0;
      for (let j = 0; j < D; j++) z += Xb[i][j] * w[j];
      const pi = sigmoid(z);
      const eps = 1e-12;
      ll += y[i] * Math.log(pi + eps) + (1 - y[i]) * Math.log(1 - pi + eps);
    }
    if (Math.abs(ll - prevLL) < tol) break;
    prevLL = ll;
  }

  return {
    weights: w,
    means,
    stds,
    iterations: iter + 1,
    finalLogLikelihood: prevLL,
  };
}

export function predictProb(model: LogRegModel, x: number[]): number {
  const D = model.weights.length;
  let z = model.weights[D - 1]; // bias
  for (let j = 0; j < x.length; j++) {
    const std = model.stds[j] || 1;
    const stdized = (x[j] - model.means[j]) / std;
    z += model.weights[j] * stdized;
  }
  return sigmoid(z);
}
