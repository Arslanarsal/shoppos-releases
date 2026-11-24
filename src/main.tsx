import { createRoot } from "react-dom/client";
import App from "./App";
import { startTranslator } from "./i18n";
import "./styles.css";

startTranslator();
createRoot(document.getElementById("root")!).render(<App />);
