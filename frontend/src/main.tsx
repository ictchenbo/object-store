import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTheme } from "./components/layout/ThemeToggle";
import "./index.css";

// 中文注释：先初始化主题，避免深色模式闪烁。
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
