// The orders placed from this browser, newest first: [{ orderId, placedAt, handledBy }].
// Kept in localStorage so the list survives a reload. The backend has no
// per-user order list yet, so this is the only record of "my orders".
const KEY = "orders";

export function loadOrders() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? [];
  } catch {
    return [];
  }
}

export function addOrder(order) {
  localStorage.setItem(KEY, JSON.stringify([order, ...loadOrders()]));
}

export function removeOrders(orderIds) {
  const gone = new Set(orderIds);
  localStorage.setItem(KEY, JSON.stringify(loadOrders().filter((o) => !gone.has(o.orderId))));
}
