export function createOrder(input) {
  const order = validateOrder(input);
  return publishOrder(order);
}

function validateOrder(input) {
  return { ...input, valid: true };
}

function publishOrder(order) {
  return { ...order, published: true };
}
