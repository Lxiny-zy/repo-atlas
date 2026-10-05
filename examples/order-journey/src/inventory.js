// Synthetic local example. This is not a production inventory service.
const available = new Map([['notebook', 10], ['pen', 30]]);

export function reserveStock(productId, quantity) {
  const remaining = available.get(productId) || 0;
  if (remaining < quantity) return false;
  available.set(productId, remaining - quantity);
  return true;
}

export function releaseStock(productId, quantity) {
  available.set(productId, (available.get(productId) || 0) + quantity);
}
