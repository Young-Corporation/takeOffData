import LabelApp from "./components/LabelApp";
import AdminApp from "./components/AdminApp";

// Admin gate — when ?admin=1 is in the URL we render the read-only admin
// dashboard instead of the labeling UI. The bookmark belongs to the developer;
// workers never see admin features.
const IS_ADMIN = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("admin") === "1";

export default function App() {
  return IS_ADMIN ? <AdminApp /> : <LabelApp />;
}
