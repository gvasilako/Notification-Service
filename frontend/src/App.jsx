import OrderDetail from "./OrderDetail.jsx";
import OrderList from "./OrderList.jsx";
import { usePath } from "./router.jsx";

export default function App() {
  const path = usePath();
  const match = path.match(/^\/orders\/([^/]+)$/);

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 600, margin: "2rem auto" }}>
      {match ? (
        // key: a different order gets a fresh page, with its own stream and
        // history, instead of reusing the previous order's state.
        <OrderDetail key={match[1]} orderId={match[1]} />
      ) : (
        <OrderList />
      )}
    </main>
  );
}
