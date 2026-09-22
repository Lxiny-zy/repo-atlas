export function createOrder(input) {
  const order = validateOrder(input);
  return publishOrder(order);
}

const internalToken = "fixture-secret";

function validateOrder(input) {
  return { ...input, valid: true };
}

function publishOrder(order) {
  return { ...order, published: true };
}
