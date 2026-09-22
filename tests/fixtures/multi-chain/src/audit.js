export function recordAudit(order) {
  return { orderId: order.id, recorded: true };
}
