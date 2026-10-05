import { reserveStock, releaseStock } from './inventory.js';
import { findOrder, saveOrder } from './records.js';

export function submitOrder({ orderId, productId, quantity }) {
  if (typeof orderId !== 'string' || !orderId.trim() || !productId || !Number.isInteger(quantity) || quantity < 1) {
    return { accepted: false, message: '请填写订单号、商品和正确的购买数量。' };
  }
  const existing = findOrder(orderId);
  if (existing) return { accepted: true, order: existing };
  if (!reserveStock(productId, quantity)) {
    return { accepted: false, message: '商品库存不足，本次未创建订单。' };
  }
  const order = saveOrder({ id: orderId, productId, quantity, status: '待处理' });
  return { accepted: true, order };
}

export function cancelOrder(orderId) {
  const order = findOrder(orderId);
  if (!order) return { accepted: false, message: '未找到这笔订单。' };
  if (order.status === '已取消') return { accepted: true, order };
  releaseStock(order.productId, order.quantity);
  const cancelled = saveOrder({ ...order, status: '已取消' });
  return { accepted: true, order: cancelled };
}
