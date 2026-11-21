import { useEffect, useState } from "react";

export default function App() {
  const [notifications, setNotifications] = useState([]);
  const [message, setMessage] = useState("");

  const load = async () => {
    const res = await fetch("/api/notifications");
    const data = await res.json();
    setNotifications(data.notifications);
  };

  useEffect(() => {
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!message.trim()) return;
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    setMessage("");
    load();
  };

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 600, margin: "2rem auto" }}>
      <h1>Notifications</h1>
      <form onSubmit={submit}>
        <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="New notification" />
        <button type="submit">Send</button>
      </form>
      <ul>
        {notifications.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </main>
  );
}
