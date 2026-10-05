// In-memory records disappear when the example process exits.
const orders = new Map();

export function findOrder(orderId) {
  return orders.get(orderId);
}

export function saveOrder(order) {
  orders.set(order.id, order);
  return order;
}
